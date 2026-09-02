// Post-draw cron. Two jobs, in this order:
//
//   1. POOL OPERATIONS (plan Phase 9) — crank `FarpotPool.claimBatch` for every settled drawing
//      that still owes claims, and run the §8.1 staleness monitor. This is the money path: until
//      it runs, a settled pool's winnings sit uncollected on Megapot.
//   2. Post-draw notifications — tell players to check their results. "Player" means either
//      route: holding your own ticket, or having a stake in what the pool's tickets did.
//
// The order is load-bearing. Notifications are sent sequentially against Farcaster's
// 1-per-30s-per-token rate limit, so a backlog of missed rounds can legitimately consume the
// whole function budget. Running them first would let a notification backlog starve cranking
// indefinitely, and nothing would ever report that it had.
//
// Cranking also runs on EVERY tick, not only when a new round appeared: the notification marker
// says nothing about whether the claim cursor was drained, and a previous run can time out
// mid-drawing.
//
// Post-draw notifier — tells players to check results.
//
// How it stays idempotent: the Jackpot's `currentDrawingId` increments when a
// new round opens, which means the PREVIOUS round just settled. We store the
// last id we notified for; when current > marker we notify for EVERY un-notified
// round between marker and currentId, then advance the marker to currentId.
// Safe to run as often as you like — each round is notified exactly once.
//
// Note on coalescing: Hobby plan only fires once per day. If multiple rounds
// accumulated (e.g. cron missed a day), we send one notification per missed round.
// Farcaster rate limits are 1 notif/30s/token so N rounds = N×30s minimum.
// We send them sequentially; if the function times out mid-batch the marker is
// NOT advanced so the remaining rounds fire on the next tick.
import { NextResponse } from "next/server";
import { createPublicClient, http, fallback, formatUnits } from "viem";
import { base } from "viem/chains";
import { JACKPOT_ADDRESS, JACKPOT_ABI } from "@/lib/constants";
import {
  allTokenEntries,
  sendNotifications,
  getDrawMarker,
  setDrawMarker,
  claimNudgeSlot,
  getNudgeStep,
  advanceNudgeStep,
  resetNudgeState,
  type SubscriberToken,
} from "@/lib/notifications";
import {
  fetchRoundPlayers,
  loadAddressesForFids,
  classifyWithPool,
  nudgeDecision,
} from "@/lib/notify-segments";
import { fetchPoolParticipants } from "@/lib/notify-pool";
import { runCrank, runStalenessMonitor } from "@/lib/pool-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_URL = "https://farpot.vercel.app";

const apiKey = process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY;
const publicClient = createPublicClient({
  chain: base,
  transport: fallback([
    // BASE_RPC_URL first, matching the contributor route and `pool-ops`. This route's
    // `currentDrawingId` is the input to BOTH pool jobs, so if it resolved against a different
    // endpoint than they do, the cron could crank one chain's drawings using another chain's id.
    ...(process.env.BASE_RPC_URL ? [http(process.env.BASE_RPC_URL)] : []),
    ...(apiKey
      ? [http(`https://api.developer.coinbase.com/rpc/v1/base/${apiKey}`)]
      : []),
    http("https://base.publicnode.com"),
    http("https://1rpc.io/base"),
    http("https://mainnet.base.org"),
  ]),
});

export async function GET(req: Request) {
  console.log("[cron:notify] cron tick started");

  // Auth: Vercel Cron (and only it) sends the CRON_SECRET.
  // Fail-closed: unset secret = reject everything (no world-callable cron).
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    console.warn("[cron:notify] auth failed — missing or wrong CRON_SECRET");
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Dry run: classify and log exactly what WOULD be sent, without sending, advancing the
  // draw marker, or claiming throttle slots. Still behind CRON_SECRET. This is the only way
  // to verify segmentation against real data — the Upstash credentials are marked sensitive
  // in Vercel, so the token store cannot be exercised from a local machine.
  //
  // SCOPE: this flag covers the NOTIFICATION half only. Pool cranking and the staleness
  // monitor above have already run by this point and are not suppressed — they are idempotent
  // and are the money path, so a dry run must not be a reason to skip them.
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  if (dryRun) console.log("[cron:notify] DRY RUN — no sends, no marker advance, no throttle claims");

  // RPC read — wrapped so a transient failure doesn't silently kill the run.
  let currentId: bigint;
  try {
    currentId = (await publicClient.readContract({
      address: JACKPOT_ADDRESS,
      abi: JACKPOT_ABI,
      functionName: "currentDrawingId",
    })) as bigint;
  } catch (err) {
    console.error("[cron:notify] RPC failed — currentDrawingId unreadable:", err);
    return NextResponse.json(
      { ok: false, error: "rpc_failure", detail: String(err) },
      { status: 502 },
    );
  }

  // ── Pool operations, before notifications and independent of the marker ──────────────────
  //
  // Both are wrapped: a pool failure must never stop the notifications, which are a separate
  // feature with their own users. Anything worth waking someone for has already alerted from
  // inside `pool-ops`; `alerted` just tells this route to answer non-2xx as well, so Vercel's
  // own cron-failure notification fires even when no webhook is configured.
  let stale: Awaited<ReturnType<typeof runStalenessMonitor>> | { error: string } | undefined;
  try {
    stale = await runStalenessMonitor(currentId);
  } catch (err) {
    console.error("[cron:notify] staleness monitor threw:", err);
    stale = { error: String(err) };
  }

  let crank:
    | Awaited<ReturnType<typeof runCrank>>
    | { status: "error"; detail: string; alerted: false; degraded: true }
    | undefined;
  try {
    crank = await runCrank(currentId);
  } catch (err) {
    console.error("[cron:notify] crank threw:", err);
    crank = { status: "error", detail: String(err), alerted: false, degraded: true };
  }
  console.log("[cron:crank] status", crank.status, JSON.stringify(crank));

  // `degraded` is here, not just `alerted`, and that is the whole point of the backstop.
  // Alerts dedupe weekly and some failures never alert at all, so keying the HTTP status on
  // alerting alone would let cranking fail EVERY day while the cron reported success — which is
  // precisely the silent-money-path failure this channel exists to catch. A monitor that threw
  // counts too: it means the §8.1 stop condition did not run.
  const needsAttention = Boolean(
    crank.alerted ||
      crank.degraded ||
      (stale && "alerted" in stale && stale.alerted) ||
      (stale && "error" in stale),
  );

  // Every response carries the pool result, and an alerted run answers 500 regardless of how the
  // notification half went. That non-2xx IS an alert channel: Vercel marks the run failed and
  // notifies, which is the one path that needs no environment variable to have been set
  // correctly. Re-running the cron is harmless — cranking and the marker are both idempotent.
  const respond = (body: Record<string, unknown>, status = 200) =>
    NextResponse.json({ ...body, pool: { crank, stale } }, { status: needsAttention ? 500 : status });

  // getDrawMarker() can throw when Redis is unreachable — catch it so we 502
  // instead of crashing with an opaque server error.
  let marker: bigint | null;
  try {
    marker = await getDrawMarker();
  } catch (err) {
    console.error("[cron:notify] Redis failed — cannot read marker:", err);
    return respond({ ok: false, error: "redis_failure", detail: String(err) }, 502);
  }

  // First ever run: record where we are, don't blast a notice for an old round.
  if (marker === null) {
    if (!dryRun) await setDrawMarker(currentId);
    console.log("[cron:notify] first run — initialised marker to", currentId.toString());
    return respond({ ok: true, init: true, currentId: currentId.toString() });
  }

  // No new round since last run → nothing to do for NOTIFICATIONS. Cranking has already run
  // above, because "no new round" says nothing about whether a previous round's claims landed.
  if (currentId <= marker) {
    console.log("[cron:notify] no new round — currentId", currentId.toString(), "marker", marker.toString());
    return respond({ ok: true, skipped: true, currentId: currentId.toString() });
  }

  // Coalesce: notify for EVERY un-notified round between marker and currentId.
  // If the cron missed a day (or Redis was down), we catch up instead of skipping.
  const roundsToNotify: bigint[] = [];
  for (let r = marker; r < currentId; r++) {
    roundsToNotify.push(r);
  }
  console.log("[cron:notify] coalescing", roundsToNotify.length, "round(s):", roundsToNotify.map(String).join(", "));

  // Headline jackpot for the non-player message — the SAME read the app's headline uses
  // (`getDrawingTierPayouts(currentDrawingId)[11]`), so the notification and the UI cannot
  // quote different numbers. Failure is non-fatal and deliberately does not block results:
  // we skip the nudge rather than state a figure we did not actually read.
  let jackpotLabel: string | null = null;
  try {
    const tiers = (await publicClient.readContract({
      address: JACKPOT_ADDRESS,
      abi: JACKPOT_ABI,
      functionName: "getDrawingTierPayouts",
      args: [currentId],
    })) as readonly bigint[];
    const usd = Number(formatUnits(tiers[11], 6));
    jackpotLabel =
      usd >= 1_000_000 ? `$${(usd / 1_000_000).toFixed(1)}M` : `$${(usd / 1_000).toFixed(0)}K`;
  } catch (err) {
    console.error("[cron:notify] tier payouts unreadable — skipping jackpot nudge:", err);
  }

  const subscribers = await allTokenEntries();
  console.log("[cron:notify] loaded", subscribers.length, "notification token(s)");

  if (subscribers.length === 0) {
    // Nobody to notify — still advance the marker so we don't re-notify next tick.
    if (!dryRun) await setDrawMarker(currentId);
    console.log("[cron:notify] no tokens — marker advanced to", currentId.toString(), "(skipped", roundsToNotify.length, "round notification(s))");
    return respond({ ok: true, roundsSkipped: roundsToNotify.map(String), recipients: 0, result: [] });
  }

  // fid → verified addresses, cache-first. One Neynar call per 100 uncached subscribers.
  const addressesByFid = await loadAddressesForFids(subscribers.map((s) => s.fid));

  // ── Pass 1: results, to the people who actually played ──────────────────────────────
  //
  // This is the fix for the original defect: the results copy says "tap to see if you won",
  // which is false for anyone who never bought a ticket, and it used to go to every token
  // every single day.
  const notifiedFids = new Set<number>();
  const unknownFids = new Set<number>();
  const allResults: Array<{
    round: string;
    recipients: number;
    viaTickets: number;
    viaPool: number;
    result: unknown;
  }> = [];

  // Every verified address we know about, deduped and lowercased — the candidate list the pool
  // lookup tests against. Built once, outside the round loop: it is the same set for every
  // round, and rebuilding it per round would multiply the multicall size for nothing.
  const candidateAddresses = [
    ...new Set(
      subscribers.flatMap((s) => (addressesByFid.get(s.fid) ?? []).map((a) => a.toLowerCase())),
    ),
  ];

  for (const round of roundsToNotify) {
    const roster = await fetchRoundPlayers(round);
    if (roster === null) {
      // A partial or missing roster would misfile real players as non-players, so bail rather
      // than classify against it. The marker moves up to THIS round — not past it — so the
      // rounds already notified above are not re-sent on the next tick while the failed one
      // still is. (Farcaster dedupes a repeated notificationId for 24h, but the next tick is
      // ~24h away, which is exactly the boundary that dedupe stops covering.)
      console.error("[cron:notify] roster unavailable for round", round.toString(), "— parking marker here");
      if (!dryRun) await setDrawMarker(round);
      return respond(
        { ok: false, error: "roster_unavailable", round: round.toString(), rounds: roundsToNotify.map(String) },
        503,
      );
    }

    // The second way of playing. Megapot's roster lists the POOL as the ticket holder, never
    // the people in it, so without this a group-buy joiner reads as someone who has not played.
    const poolRoster = await fetchPoolParticipants(publicClient, round, candidateAddresses);
    if (poolRoster === null) {
      // Parked for exactly the reason a missing Megapot roster is: the addresses this lookup
      // failed to confirm are the group-buy participants, and letting the marker advance past
      // the round would not merely delay their notification, it would drop it — permanently,
      // for the one cohort holding an unclaimed share that only they can `claim()`. Direct
      // ticket holders are delayed a tick rather than skipped, which is the cheaper mistake.
      console.error("[cron:notify] pool lookup failed for round", round.toString(), "— parking marker here");
      if (!dryRun) await setDrawMarker(round);
      return respond(
        { ok: false, error: "pool_unavailable", round: round.toString(), rounds: roundsToNotify.map(String) },
        503,
      );
    }

    // Split by ROUTE, not merged, because the two cohorts need different landing tabs — a
    // pool-only participant sent to Results reads "tap to see if you won" and then finds an
    // empty ticket list, because the tickets belong to the pool. See `classifyWithPool`.
    const ticketPlayers: SubscriberToken[] = [];
    const poolPlayers: SubscriberToken[] = [];
    for (const sub of subscribers) {
      const result = classifyWithPool(addressesByFid.get(sub.fid) ?? null, roster, poolRoster);
      if (result.segment === "unknown") {
        unknownFids.add(sub.fid);
        continue;
      }
      if (result.segment !== "player") continue;
      (result.via === "tickets" ? ticketPlayers : poolPlayers).push(sub);
    }
    const players = [...ticketPlayers, ...poolPlayers];

    console.log(
      "[cron:notify] round", round.toString(),
      "roster", roster.size,
      "pool", poolRoster.size,
      "players", players.length,
      "(tickets", ticketPlayers.length, "pool-only", poolPlayers.length, ")",
      "unknown", unknownFids.size,
    );

    if (players.length === 0) {
      allResults.push({ round: round.toString(), recipients: 0, viaTickets: 0, viaPool: 0, result: [] });
      continue;
    }

    for (const p of players) notifiedFids.add(p.fid);
    if (dryRun) {
      allResults.push({
        round: round.toString(),
        recipients: players.length,
        viaTickets: ticketPlayers.length,
        viaPool: poolPlayers.length,
        result: "dry-run",
      });
      continue;
    }

    // Playing graduates someone back to the results path and rewinds the nudge ladder, so a
    // lapse after real engagement starts again at the shortest rung. Joining a group buy is
    // playing, so the pool cohort resets too.
    for (const p of players) await resetNudgeState(p.fid);

    // Same title and body for both cohorts — one notification, as far as anyone receiving it is
    // concerned. Only `targetUrl` differs, and the two token lists are disjoint by construction,
    // so reusing the `draw-<round>` id cannot deliver twice: the id dedupes per token.
    const sends: unknown[] = [];
    for (const [tokens, tab] of [
      [ticketPlayers, "results"],
      [poolPlayers, "pool"],
    ] as const) {
      if (tokens.length === 0) continue;
      sends.push(
        await sendNotifications({
          notificationId: `draw-${round}`,
          title: "🎰 The draw is in!",
          body: `Round #${round} results are live — tap to see if you won.`,
          targetUrl: `${APP_URL}/?tab=${tab}&n=results`,
          tokens,
        }),
      );
    }
    allResults.push({
      round: round.toString(),
      recipients: players.length,
      viaTickets: ticketPlayers.length,
      viaPool: poolPlayers.length,
      result: sends,
    });
  }

  // ── Pass 2: jackpot status, to everyone who did NOT just get results ────────────────
  //
  // Ordering is the whole mechanism for "nobody gets two notifications in a day": the
  // recipient list is built by exclusion, here, rather than by trusting the platform to
  // suppress the second send. It would not — the documented limits are 1 per 30s and 100
  // per day per token, so both messages WOULD be delivered.
  const nudgeCandidates = subscribers.filter(
    (s) => !notifiedFids.has(s.fid) && !unknownFids.has(s.fid),
  );

  const nudgeSkips = { throttled: 0, laddered: 0 };
  const nudgeTargets: SubscriberToken[] = [];
  for (const sub of nudgeCandidates) {
    const decision = nudgeDecision(await getNudgeStep(sub.fid));
    if (!decision.send) {
      // Ladder exhausted — this person has heard from us three times without playing.
      nudgeSkips.laddered++;
      continue;
    }
    if (dryRun) {
      nudgeTargets.push(sub);
      continue;
    }
    // The claim IS the throttle: SET NX EX, so the key's TTL is the window and two
    // overlapping runs cannot both nudge the same person.
    if (!(await claimNudgeSlot(sub.fid, decision.ttlSeconds))) {
      nudgeSkips.throttled++;
      continue;
    }
    nudgeTargets.push(sub);
  }

  let nudgeResult: unknown = [];
  if (nudgeTargets.length > 0 && jackpotLabel) {
    if (dryRun) {
      nudgeResult = "dry-run";
    } else {
      for (const t of nudgeTargets) await advanceNudgeStep(t.fid);
      nudgeResult = await sendNotifications({
        notificationId: `jackpot-${currentId}`,
        title: "🎰 Today's Farpot jackpot",
        body: `Round #${currentId} is open — the jackpot is ${jackpotLabel}. Tap to play.`,
        targetUrl: `${APP_URL}/?n=jackpot`,
        tokens: nudgeTargets,
      });
    }
  }

  console.log(
    "[cron:notify] jackpot nudge —",
    "candidates", nudgeCandidates.length,
    "sent", jackpotLabel ? nudgeTargets.length : 0,
    "throttled", nudgeSkips.throttled,
    "ladder-exhausted", nudgeSkips.laddered,
    "jackpot", jackpotLabel ?? "unavailable",
  );

  if (!dryRun) {
    await setDrawMarker(currentId);
    console.log("[cron:notify] marker advanced to", currentId.toString());
  }

  return respond({
    ok: true,
    dryRun,
    rounds: roundsToNotify.map(String),
    subscribers: subscribers.length,
    results: allResults,
    nudge: {
      jackpot: jackpotLabel,
      candidates: nudgeCandidates.length,
      sent: jackpotLabel ? nudgeTargets.length : 0,
      ...nudgeSkips,
      unknown: unknownFids.size,
      result: nudgeResult,
    },
  });
}

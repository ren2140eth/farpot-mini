// Post-draw cron. Two jobs, in this order:
//
//   1. POOL OPERATIONS (plan Phase 9) — crank `FarpotPool.claimBatch` for every settled drawing
//      that still owes claims, and run the §8.1 staleness monitor. This is the money path: until
//      it runs, a settled pool's winnings sit uncollected on Megapot.
//   2. Post-draw notifications — tell players to check their results.
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
import { createPublicClient, http, fallback } from "viem";
import { base } from "viem/chains";
import { JACKPOT_ADDRESS, JACKPOT_ABI } from "@/lib/constants";
import {
  allTokens,
  sendNotifications,
  getDrawMarker,
  setDrawMarker,
} from "@/lib/notifications";
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
    await setDrawMarker(currentId);
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

  const tokens = await allTokens();
  console.log("[cron:notify] loaded", tokens.length, "notification token(s)");

  if (tokens.length === 0) {
    // Nobody to notify — still advance the marker so we don't re-notify next tick.
    await setDrawMarker(currentId);
    console.log("[cron:notify] no tokens — marker advanced to", currentId.toString(), "(skipped", roundsToNotify.length, "round notification(s))");
    return respond({ ok: true, roundsSkipped: roundsToNotify.map(String), recipients: 0, result: [] });
  }

  // Send one notification per missed round. If the function times out mid-batch
  // the marker is NOT advanced so the remaining rounds fire on the next tick.
  const allResults: Array<{ round: string; result: unknown }> = [];
  for (const round of roundsToNotify) {
    console.log("[cron:notify] sending notification for round", round.toString());
    const result = await sendNotifications({
      notificationId: `draw-${round}`,
      title: "🎰 The draw is in!",
      body: `Round #${round} results are live — tap to see if you won.`,
      targetUrl: `${APP_URL}/?tab=results`,
      tokens,
    });
    allResults.push({ round: round.toString(), result });
  }

  await setDrawMarker(currentId);
  console.log("[cron:notify] marker advanced to", currentId.toString());

  return respond({
    ok: true,
    rounds: roundsToNotify.map(String),
    recipients: tokens.length,
    results: allResults,
  });
}

// Post-draw notifier — runs on a Vercel Cron, tells players to check results.
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_URL = "https://farpot.vercel.app";

const apiKey = process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY;
const publicClient = createPublicClient({
  chain: base,
  transport: fallback([
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

  // getDrawMarker() can throw when Redis is unreachable — catch it so we 502
  // instead of crashing with an opaque server error.
  let marker: bigint | null;
  try {
    marker = await getDrawMarker();
  } catch (err) {
    console.error("[cron:notify] Redis failed — cannot read marker:", err);
    return NextResponse.json(
      { ok: false, error: "redis_failure", detail: String(err) },
      { status: 502 },
    );
  }

  // First ever run: record where we are, don't blast a notice for an old round.
  if (marker === null) {
    await setDrawMarker(currentId);
    console.log("[cron:notify] first run — initialised marker to", currentId.toString());
    return NextResponse.json({ ok: true, init: true, currentId: currentId.toString() });
  }

  // No new round since last run → nothing to do.
  if (currentId <= marker) {
    console.log("[cron:notify] no new round — currentId", currentId.toString(), "marker", marker.toString());
    return NextResponse.json({ ok: true, skipped: true, currentId: currentId.toString() });
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
    return NextResponse.json({ ok: true, roundsSkipped: roundsToNotify.map(String), recipients: 0, result: [] });
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

  return NextResponse.json({
    ok: true,
    rounds: roundsToNotify.map(String),
    recipients: tokens.length,
    results: allResults,
  });
}

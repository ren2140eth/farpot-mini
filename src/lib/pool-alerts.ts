// Operational alerting for the pool cron.
//
// Design §8.1 is explicit that the stop conditions "must not depend on somebody noticing", so
// an alert has to reach a human without anyone reading logs. There are three channels here and
// they are deliberately layered, because each one fails differently:
//
//   1. `console.error` with a greppable `[pool:ALERT]` prefix — always fires, needs no config,
//      and is what Vercel's log drains match on.
//   2. `POOL_ALERT_WEBHOOK_URL` — a plain JSON POST. The body carries BOTH `content` (Discord)
//      and `text` (Slack) so either endpoint works without a per-provider adapter.
//   3. The caller returns a non-2xx from the cron route, which makes Vercel mark the run failed
//      and fire its own cron-failure notification. That one needs no env var at all, which is
//      what makes it the backstop if 2 was never configured.
//
// Dedupe exists so a jam that is correctly NOT being retried does not page daily. It is a TTL,
// not a permanent suppression: an unfixed condition should resurface, just weekly rather than
// every tick.

import { alertAlreadySent, markAlertSent } from "./pool-cache";

export type AlertKind =
  | "crank-fatal" // a deterministic revert that is not a size problem — do not retry
  | "crank-terminal" // count == 1 still failing — needs a human
  | "crank-disabled" // settled tickets are waiting but no keeper key is configured
  | "keeper-underfunded" // keeper cannot pay for the next crank
  | "upstream-stale"; // §8.1 — Megapot appears to have stopped advancing

export interface AlertRecord {
  kind: AlertKind;
  key: string;
  message: string;
  detail?: unknown;
}

/**
 * Raise an operational alert, at most once per `kind`+`key` per week.
 *
 * `key` is what makes the dedupe correct rather than merely quiet: a jam on drawing 140 and a
 * jam on drawing 141 are different incidents and must both be seen, so the drawing id belongs
 * in the key. Using only the kind would hide the second one behind the first.
 *
 * Never throws. An alert that takes the caller down with it would convert a recoverable
 * incident into an outage, and the console line has already been written by then anyway.
 */
export async function raiseAlert(record: AlertRecord): Promise<boolean> {
  // Channel 1 first and unconditionally, so a failure in 2 cannot swallow the evidence.
  console.error(`[pool:ALERT] ${record.kind} (${record.key}): ${record.message}`, record.detail ?? "");

  let firstTime = true;
  try {
    firstTime = !(await alertAlreadySent(record.kind, record.key));
    if (firstTime) await markAlertSent(record.kind, record.key);
  } catch (err) {
    // No cache means no dedupe. Alerting twice is strictly better than alerting never, so a
    // Redis outage degrades toward noise rather than toward silence.
    console.error("[pool:ALERT] dedupe unavailable, alerting anyway:", err);
  }

  if (!firstTime) {
    console.warn(`[pool:ALERT] suppressed duplicate ${record.kind} (${record.key})`);
    return false;
  }

  const url = process.env.POOL_ALERT_WEBHOOK_URL;
  if (!url) {
    console.warn("[pool:ALERT] POOL_ALERT_WEBHOOK_URL unset — console + cron status only");
    return true;
  }

  const summary = `🚨 Farpot pool: ${record.message} (${record.kind}, ${record.key})`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `content` is Discord's field, `text` is Slack's. Sending both means the same URL works
      // for either without this file knowing which one it is talking to.
      body: JSON.stringify({
        content: summary,
        text: summary,
        kind: record.kind,
        key: record.key,
        detail: record.detail === undefined ? undefined : String(record.detail),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) console.error(`[pool:ALERT] webhook returned ${res.status}`);
  } catch (err) {
    console.error("[pool:ALERT] webhook post failed:", err);
  }
  return true;
}

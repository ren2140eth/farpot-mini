// Cron-side operations for the pool: crank the claim cursor, and watch for the upstream
// migration that design §8.1 says must never depend on somebody noticing.
//
// Split out of the route so the route stays a thin, auditable shell and so the crank proof can
// drive exactly the code that runs in production rather than a re-typed copy of it — the same
// reason the soft-cap arithmetic lives in `pool-cap.ts`.

import { createPublicClient, createWalletClient, fallback, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  FARPOT_POOL_ABI,
  FARPOT_POOL_ADDRESS,
  JACKPOT_ABI,
  JACKPOT_ADDRESS,
} from "./constants";
import {
  bumpCrankFailStreak,
  cacheEnabled,
  clearCrankFailStreak,
  getCrankCursor,
  clearHalt,
  getHalt,
  getLastSeenDrawingId,
  listHalts,
  recordHalt,
  setCrankCursor,
  setLastSeenDrawingId,
} from "./pool-cache";
import { raiseAlert } from "./pool-alerts";
import {
  crankSettledDrawings,
  findPendingDrawings,
  nextCrankCursor,
  type CrankReport,
  type PoolPublicClient,
} from "./pool-crank";

// Two missed daily draws. Long enough that a single late settlement is not an incident, short
// enough that a genuine upstream migration is caught within a couple of days.
const STALE_AFTER_SECONDS = BigInt(48 * 60 * 60);

// Below this the keeper cannot be relied on to fund the next crank. A full 75-ticket batch is
// ~3.4M gas, which on Base costs a small fraction of a cent — so hitting this floor means the
// wallet was never topped up, not that cranking is expensive.
const MIN_KEEPER_WEI = BigInt(1_000_000_000_000_000); // 0.001 ETH

// Leave the rest of the function's budget to the notification loop, which sends sequentially at
// Farcaster's 1-per-30s rate limit and can legitimately run long.
const CRANK_BUDGET_MS = 90_000;

function transport() {
  const apiKey = process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY;
  // BASE_RPC_URL first when set — the same precedence the contributor route uses, so both
  // pool paths can be pointed at one endpoint (or at a fork) together.
  const custom = process.env.BASE_RPC_URL;
  return fallback([
    ...(custom ? [http(custom)] : []),
    ...(apiKey ? [http(`https://api.developer.coinbase.com/rpc/v1/base/${apiKey}`)] : []),
    http("https://base.publicnode.com"),
    http("https://1rpc.io/base"),
    http("https://mainnet.base.org"),
  ]);
}

function keeperAccount() {
  const raw = process.env.POOL_KEEPER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  // Fail loudly on a malformed key rather than letting viem throw somewhere less legible. A
  // typo'd key and an absent key must not look the same: one is a misconfiguration to fix, the
  // other is a deliberate "cranking is off" state.
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("POOL_KEEPER_PRIVATE_KEY is set but is not a 32-byte hex key");
  }
  return privateKeyToAccount(key);
}

export interface CrankOutcome {
  status: "ok" | "disabled" | "skipped" | "error";
  keeper?: string;
  detail?: string;
  report?: CrankReport;
  alerted: boolean;
  /**
   * The run did not complete its work, whatever the notification half did.
   *
   * Separate from `alerted` because the cron's HTTP status must reflect BOTH. A crank that fails
   * on RPC every single day is not "no alert fired, so all is well" — it is the money path
   * silently stopped, and answering 200 would defeat the failed-cron backstop that is supposed to
   * catch exactly that.
   */
  degraded: boolean;
}

// One bad tick is noise; two in a row on a daily cron means a day and a half of no claims. `error`
// escalates immediately because it means cranking actually broke, while `skipped` (a read that
// could not be completed) gets one grace tick before paging.
const SKIP_STREAK_BEFORE_ALERT = 2;

/** Record a failed/incomplete run and decide whether it has now gone on long enough to page. */
async function noteCrankFailure(
  status: "skipped" | "error",
  detail: string,
): Promise<boolean> {
  let streak = 1;
  if (cacheEnabled) {
    try {
      streak = await bumpCrankFailStreak();
    } catch {
      // No counter means no history to judge persistence by. Escalate rather than stay quiet:
      // a silent money path is the worse failure.
      streak = SKIP_STREAK_BEFORE_ALERT;
    }
  }
  if (status === "error" || streak >= SKIP_STREAK_BEFORE_ALERT) {
    await raiseAlert({
      kind: "crank-disabled",
      key: `crank-failing`,
      message: `pool cranking has not completed for ${streak} consecutive run(s) — settled winnings may be sitting uncollected`,
      detail,
    });
    return true;
  }
  return false;
}

/**
 * Drain every settled drawing that still owes claims.
 *
 * Runs on EVERY tick, not only when a new round appeared. A previous run can time out
 * mid-drawing, and the notification marker says nothing about whether the claim cursor was
 * drained — tying cranking to "is there a new round" would leave those tickets unclaimed until
 * the next draw happened to arrive.
 */
export async function runCrank(currentDrawingId: bigint): Promise<CrankOutcome> {
  const publicClient = createPublicClient({ chain: base, transport: transport() });

  let account;
  try {
    account = keeperAccount();
  } catch (err) {
    await raiseAlert({
      kind: "crank-disabled",
      key: "bad-key",
      message: "POOL_KEEPER_PRIVATE_KEY is malformed — no winnings can be collected",
      detail: err,
    });
    return { status: "error", detail: String(err), alerted: true, degraded: true };
  }

  // Is there anything to do at all? Answer this BEFORE worrying about the keeper, because "no
  // key configured" is only an incident when money is actually waiting.
  const cursor = cacheEnabled ? await getCrankCursor().catch(() => null) : null;

  if (!account) {
    const pending = await pendingWork(publicClient, currentDrawingId, cursor);
    if (pending === null) {
      const detail = "no keeper key; pending work unknown (RPC failed)";
      await noteCrankFailure("skipped", detail);
      return { status: "skipped", detail, alerted: false, degraded: true };
    }
    if (pending) {
      await raiseAlert({
        kind: "crank-disabled",
        key: `drawing-${currentDrawingId}`,
        message:
          "settled pool tickets are waiting to be claimed but POOL_KEEPER_PRIVATE_KEY is not set — winnings are sitting on Megapot uncollected",
      });
      return { status: "disabled", detail: "keeper key unset with work pending", alerted: true, degraded: true };
    }
    return { status: "disabled", detail: "keeper key unset; nothing pending", alerted: false, degraded: false };
  }

  const walletClient = createWalletClient({ account, chain: base, transport: transport() });

  let maxClaimBatch: number;
  try {
    maxClaimBatch = Number(
      (await publicClient.readContract({
        address: FARPOT_POOL_ADDRESS,
        abi: FARPOT_POOL_ABI,
        functionName: "MAX_CLAIM_BATCH",
      })) as bigint,
    );
  } catch (err) {
    // No ceiling read means no safe count to send, and guessing one is how a hardcoded 75 gets
    // reintroduced. Skip the run; the next tick retries.
    const detail = `MAX_CLAIM_BATCH unreadable: ${err}`;
    await noteCrankFailure("skipped", detail);
    return { status: "skipped", detail, alerted: false, degraded: true };
  }

  let report: CrankReport;
  let firedAlert = false;
  const from = cursor;
  try {
    report = await crankSettledDrawings(
      {
        publicClient,
        walletClient,
        account,
        maxClaimBatch,
        deadline: Date.now() + CRANK_BUDGET_MS,
        isHalted: async (d) => (cacheEnabled ? (await getHalt(d).catch(() => null))?.reason ?? null : null),
        // Deliberately NOT `.catch(() => {})`. A swallowed failure here reads as a recorded
        // halt, and the cursor would then step past a jam that `listHalts` can never
        // rediscover — stranding the winnings with nothing left to report them.
        onHalt: async (d, kind, reason) => {
          if (!cacheEnabled) throw new Error("no cache configured — a halt cannot be recorded");
          await recordHalt(d, { kind, reason });
        },
      },
      currentDrawingId,
      from,
    );
  } catch (err) {
    // A read failure here is transient by nature (RPC blip, multicall timeout). It is NOT an
    // alert: the next tick retries, and paging on every RPC hiccup is how an alert channel
    // becomes noise nobody reads.
    // A single blip is transient and the next tick retries — but a run that keeps failing must
    // NOT keep answering 200. `degraded` carries that to the HTTP status regardless of alerting,
    // and `noteCrankFailure` pages once the failure stops looking transient.
    console.error("[cron:crank] run failed:", err);
    const alerted = await noteCrankFailure("error", String(err));
    return { status: "error", detail: String(err), keeper: account.address, alerted, degraded: true };
  }

  // Balance check AFTER the run, so the report reflects what the keeper has left rather than
  // what it had before spending. A keeper that just ran itself dry is exactly the case worth
  // catching, and it is invisible from a before-reading.
  // A drawing that stopped because the keeper could not pay is reported as `partial`, so it is
  // retried rather than halted — but it must still page, or cranking quietly stalls at a balance
  // nobody is watching.
  const brokeOnFunds = report.drawings.some((d) => d.reason?.startsWith("keeper cannot pay"));

  try {
    const balance = await publicClient.getBalance({ address: account.address });
    if (brokeOnFunds || balance < MIN_KEEPER_WEI) {
      const fired = await raiseAlert({
        kind: "keeper-underfunded",
        key: account.address,
        message: `pool keeper ${account.address} is down to ${balance} wei — top it up or cranking stops silently`,
      });
      if (fired) firedAlert = true;
    }
  } catch {
    // A balance read failing is not worth failing the run over; the crank already succeeded.
  }

  // Re-surface halts the scan window no longer covers.
  //
  // The cursor advances past a halted drawing on purpose — one jam must not block claims for
  // every later drawing — but that means the next run's window starts beyond it and the drawing
  // stops appearing in reports altogether. Merging the halt set back in keeps a stuck pool
  // visible, and re-raising its alert lets the weekly dedupe TTL page again until a human
  // clears it. Without this, a jam alerts exactly once and then goes quiet while the money
  // stays stuck.
  if (cacheEnabled) {
    try {
      const seen = new Set(report.drawings.map((d) => d.drawingId));
      for (const halted of await listHalts()) {
        if (seen.has(halted.toString())) continue;

        // Is it STILL stuck? The alert below asserts that winnings are uncollected, and until
        // now nothing ever checked. A halt was write-only, so a drawing halted by a condition
        // that later resolved — a transient mempool failure, or somebody else's permissionless
        // `claimBatch` finishing the job — stayed in the set forever and re-raised `crank-fatal`
        // every time the weekly dedupe expired, about money that was already collected.
        //
        // `poolOf` is authoritative: a drained cursor means there is nothing left to claim for
        // this drawing, whatever the halt record says. Verified in production on drawing 156 —
        // Settled, cursor 1/1, pot $0, and still paging weekly.
        //
        // A FAILED read is not a clear. "I could not check" is not "it is fine", so the drawing
        // is re-surfaced exactly as before and re-checked next tick.
        let drained: boolean | null = null;
        try {
          const pool = (await publicClient.readContract({
            address: FARPOT_POOL_ADDRESS,
            abi: FARPOT_POOL_ABI,
            functionName: "poolOf",
            args: [halted],
          })) as readonly [bigint, bigint, bigint, number, bigint, bigint];
          // Positional: `poolOf` declares six flat outputs, so viem returns an array.
          // Slot 4 is the claim cursor, slot 5 the drawing's ticket count.
          drained = pool[5] === BigInt(0) || pool[4] >= pool[5];
        } catch (err) {
          console.error(`[cron:crank] could not verify halted drawing ${halted}:`, err);
        }

        if (drained) {
          // Clearing is what stops the false weekly page. Failing to clear is not worth failing
          // the run over — the drawing is simply re-checked and re-cleared next tick.
          await clearHalt(halted).catch((err) =>
            console.error(`[cron:crank] could not clear resolved halt ${halted}:`, err),
          );
          console.log(`[cron:crank] halt on drawing ${halted} resolved — fully claimed, cleared`);
          continue;
        }

        const record = await getHalt(halted);
        report.drawings.push({
          drawingId: halted.toString(),
          outcome: "halted",
          ticketsClaimed: 0,
          potDelta: "0",
          batches: 0,
          lastBatchSize: 0,
          txs: [],
          reason: record?.reason ?? "halted",
        });
        // The ORIGINAL kind, so the weekly dedupe recognises this as the same incident rather
        // than a fresh one — otherwise a standing halt pages on every tick.
        report.alerts.push({
          kind: record?.kind ?? "crank-fatal",
          key: `drawing-${halted}`,
          message:
            drained === null
              ? `drawing ${halted} is halted and could not be verified this run — its winnings may still be uncollected`
              : `drawing ${halted} is still halted and its winnings are still uncollected`,
          detail: record?.reason,
        });
      }
    } catch (err) {
      console.error("[cron:crank] could not read the halt set:", err);
    }
  }

  for (const alert of report.alerts) {
    // `raiseAlert` returns false when the weekly dedupe suppressed it, so a standing halt does
    // not mark every single run as needing attention.
    const fired = await raiseAlert({ kind: alert.kind, key: alert.key, message: alert.message, detail: alert.detail });
    if (fired) firedAlert = true;
  }

  // Cursor last, exactly like the scan cursor: a crash before this re-inspects a range that is
  // idempotent to re-inspect, whereas advancing first could skip a drawing that still owes
  // claims and nothing would ever look at it again.
  if (cacheEnabled) {
    const start = BigInt(report.from);
    const next = nextCrankCursor(start, report);
    // `from === null` is the first ever run: there is no cursor to move forward from, so
    // recording where this run got to is itself the advance.
    if (from === null || next > from) await setCrankCursor(next).catch(() => {});
  }

  if (cacheEnabled) await clearCrankFailStreak().catch(() => {});

  return {
    status: "ok",
    keeper: account.address,
    report,
    alerted: firedAlert,
    // A run that completed but left drawings unfinished, jammed, or unrecordable is not healthy
    // even when the weekly dedupe suppressed its alert.
    degraded: report.drawings.some(
      (d) => d.outcome === "fatal" || d.outcome === "terminal" || d.haltPersisted === false,
    ),
  };
}

/**
 * Is there a settled drawing with an undrained cursor? `null` means the question could not be
 * answered — which must never be reported as "no", because that would turn an RPC blip into
 * silent confirmation that nothing is owed.
 */
async function pendingWork(
  publicClient: PoolPublicClient,
  currentDrawingId: bigint,
  cursor: bigint | null,
): Promise<boolean | null> {
  try {
    const scan = await findPendingDrawings(publicClient, currentDrawingId, cursor);
    return scan.pending.length > 0;
  } catch {
    return null;
  }
}

export interface StalenessOutcome {
  currentDrawingId: string;
  drawingTime: string | null;
  lastSeen: string | null;
  stale: boolean;
  alerted: boolean;
}

/**
 * §8.1: watch for Megapot going away.
 *
 * A Megapot migration surfaces as a NEW Jackpot at a new address, which our immutable pool will
 * never follow — so the observable symptom is simply that `currentDrawingId` stops advancing
 * while the scheduled draw time recedes into the past. Both halves are required: an id that has
 * not moved is normal within a day, and a stale `drawingTime` alone could be a clock or
 * settlement quirk.
 *
 * The response is deliberately manual. This alert asks the OWNER to pause `join`, and the keeper
 * key is not the owner — giving the cron that power would put a hot key on the contract's only
 * privileged function for the sake of a condition that needs human judgement anyway.
 */
export async function runStalenessMonitor(currentDrawingId: bigint): Promise<StalenessOutcome> {
  const publicClient = createPublicClient({ chain: base, transport: transport() });
  const out: StalenessOutcome = {
    currentDrawingId: currentDrawingId.toString(),
    drawingTime: null,
    lastSeen: null,
    stale: false,
    alerted: false,
  };

  let drawingTime: bigint;
  try {
    const state = (await publicClient.readContract({
      address: JACKPOT_ADDRESS,
      abi: JACKPOT_ABI,
      functionName: "getDrawingState",
      args: [currentDrawingId],
    })) as { drawingTime: bigint };
    drawingTime = state.drawingTime;
    out.drawingTime = drawingTime.toString();
  } catch (err) {
    console.error("[cron:stale] getDrawingState failed:", err);
    return out;
  }

  if (!cacheEnabled) return out;

  let lastSeen: bigint | null = null;
  try {
    lastSeen = await getLastSeenDrawingId();
    out.lastSeen = lastSeen?.toString() ?? null;
  } catch (err) {
    console.error("[cron:stale] marker unreadable:", err);
    return out;
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const overdue = drawingTime !== BigInt(0) && now > drawingTime && now - drawingTime > STALE_AFTER_SECONDS;
  const notAdvanced = lastSeen !== null && lastSeen === currentDrawingId;
  out.stale = overdue && notAdvanced;

  if (out.stale) {
    const hours = Number((now - drawingTime) / BigInt(3600));
    out.alerted = await raiseAlert({
      kind: "upstream-stale",
      key: `drawing-${currentDrawingId}`,
      message:
        `Megapot drawing ${currentDrawingId} has not rolled over and its draw time is ${hours}h in the past. ` +
        `Investigate an upstream migration, and pause join() from the owner wallet if confirmed — ` +
        `claimBatch and claim stay open so contributors can still recover winnings.`,
    });
  }

  // Record last, so a failure above leaves the previous observation intact and the "has not
  // advanced" comparison still has something to compare against next run.
  try {
    await setLastSeenDrawingId(currentDrawingId);
  } catch (err) {
    console.error("[cron:stale] could not record marker:", err);
  }

  return out;
}

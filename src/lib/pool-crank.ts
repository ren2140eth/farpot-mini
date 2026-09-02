// Cron-side driver for `FarpotPool.claimBatch` (plan Phase 9, design §4).
//
// `claimBatch` is permissionless by design, but "anyone may call it" is not the same as "someone
// will". Between settlement and the first crank the pool's winnings sit unclaimed on Megapot, so
// this is the code that closes the custody window the design calls the feature's irreducible
// risk. It runs from the daily cron.
//
// ── Why the batch size is adaptive rather than 75 ──
//
// `MAX_CLAIM_BATCH` is 75 and a claim costs ~45.1k gas per ticket, so a full batch projects to
// ~3.4M gas. But winner and loser tickets do not cost the same, so the ceiling that fits varies
// with how the drawing actually went. The design is explicit that the cron must not hardcode 75
// — and equally explicit (round 5 finding 3) that halving on ANY failure is wrong, because a
// deterministic revert is usually not a size problem and blind retries would mask a real fault.
//
// The four-way sort that replaces blind halving lives in `pool-crank-classify.ts`; it is a
// separate module purely so the proof script can import it. `count === 1` still failing is
// terminal: there is nothing left to halve, so retrying can only burn gas. The design accepts
// that such a jam is a redeploy-and-investigate event, which is exactly why it must page a human
// rather than loop.

import {
  createPublicClient,
  createWalletClient,
  WaitForTransactionReceiptTimeoutError,
  type Account,
  type Hex,
  type Transport,
} from "viem";
import type { base } from "viem/chains";
import { FARPOT_POOL_ABI, FARPOT_POOL_ADDRESS, POOL_FIRST_DRAWING } from "./constants";
import {
  classifyCrankError,
  looksOutOfGas,
  nextCrankCursor,
  revertName,
  type CrankReport,
  type DrawingCrankResult,
} from "./pool-crank-classify";

export { classifyCrankError, looksOutOfGas, nextCrankCursor, revertName };
export type { CrankReport, CrankVerdict, DrawingCrankResult } from "./pool-crank-classify";

// Pinned to Base rather than viem's loose `PublicClient` / `WalletClient` aliases.
//
// Those aliases default the chain generic, and Base's OP-stack `deposit` transaction type makes
// the resulting `getBlock` signature structurally incompatible with a client actually built with
// `chain: base` — so passing a real client to a loosely-typed parameter fails to compile with a
// wall of unrelated block-type noise. Naming the chain once here is what keeps every call site
// clean.
// The third generic (`accountOrAddress`) is pinned to `undefined` for the same reason: a public
// client built without an account infers `account: undefined`, which is NOT assignable to the
// generic's `Account | JsonRpcAccount | undefined` default.
export type PoolPublicClient = ReturnType<typeof createPublicClient<Transport, typeof base, undefined>>;
export type PoolWalletClient = ReturnType<typeof createWalletClient<Transport, typeof base, Account>>;

// Estimation is a lower bound, not a promise. Phase 8 recorded anvil's `eth_estimateGas`
// under-shooting a pooled join on an OP-stack fork badly enough that the transaction consumed
// its whole estimated limit and reverted — so the estimate is padded rather than trusted.
const GAS_BUFFER_NUMERATOR = BigInt(130);
const GAS_BUFFER_DENOMINATOR = BigInt(100);

// A drawing cannot need more slices than its ticket list divided by 1, but a bug that failed to
// advance the cursor would spin. This is the backstop that turns that into a bounded, reported
// result instead of a cron that runs until the platform kills it.
const MAX_BATCHES_PER_DRAWING = 40;

// Bounded receipt wait. viem would otherwise poll well past the cron's own budget, turning one
// stalled transaction into a run that does nothing else and reports nothing.
const RECEIPT_TIMEOUT_MS = 60_000;

function isReceiptTimeout(err: unknown): boolean {
  if (err instanceof WaitForTransactionReceiptTimeoutError) return true;
  const text = err instanceof Error ? err.message.toLowerCase() : "";
  return text.includes("timed out while waiting") || text.includes("could not be found");
}

// `poolOf` reads are batched this many per multicall. Purely a request-size limit, NOT a limit
// on how far back the scan looks.
const MULTICALL_CHUNK = 50;

// Hard ceiling on drawings inspected in one run, so a cold scan is bounded rather than unbounded.
// Megapot draws daily, so this is over a decade of history — it exists to stop a pathological
// `currentDrawingId` producing an enormous run, not to express a retention policy.
export const CRANK_SCAN_LIMIT = 4000;

export interface CrankContext {
  publicClient: PoolPublicClient;
  walletClient: PoolWalletClient;
  account: Account;
  /** Read straight off the contract — the cron must not carry its own copy of this ceiling. */
  maxClaimBatch: number;
  /** Wall-clock stop, so cranking cannot eat the whole function budget and starve notifications. */
  deadline: number;
  isHalted: (drawingId: bigint) => Promise<string | null>;
  /**
   * `kind` is recorded, not just the reason.
   *
   * A later run re-raises the alert for a still-halted drawing, and alert dedupe is keyed on
   * kind AND key — so re-raising a `crank-terminal` halt as `crank-fatal` would look like a new
   * incident and page again on every single tick.
   */
  onHalt: (drawingId: bigint, kind: "crank-fatal" | "crank-terminal", reason: string) => Promise<void>;
}

type PoolSnapshot = { cursor: bigint; ticketCount: bigint };

async function readPool(client: PoolPublicClient, drawingId: bigint): Promise<PoolSnapshot> {
  const result = (await client.readContract({
    address: FARPOT_POOL_ADDRESS,
    abi: FARPOT_POOL_ABI,
    functionName: "poolOf",
    args: [drawingId],
  })) as readonly [bigint, bigint, bigint, number, bigint, bigint];
  return { cursor: result[4], ticketCount: result[5] };
}

/**
 * Drain one settled drawing's ticket list, resizing the batch as the chain demands.
 *
 * The loop re-reads `poolOf` every iteration rather than tracking the cursor locally. That is
 * what makes it safe against the race that permissionlessness creates: anyone may call
 * `claimBatch`, so a stranger's transaction can drain the slice we just estimated against. Local
 * bookkeeping would call that a fatal revert and page a human over somebody else doing our job
 * for us.
 */
async function crankDrawing(
  ctx: CrankContext,
  drawingId: bigint,
): Promise<DrawingCrankResult> {
  const base: DrawingCrankResult = {
    drawingId: drawingId.toString(),
    outcome: "drained",
    ticketsClaimed: 0,
    potDelta: "0",
    batches: 0,
    lastBatchSize: 0,
    txs: [],
  };

  let count = ctx.maxClaimBatch;
  let potDelta = BigInt(0);

  for (let iteration = 0; iteration < MAX_BATCHES_PER_DRAWING; iteration++) {
    if (Date.now() > ctx.deadline) {
      base.outcome = "partial";
      base.reason = "time budget exhausted";
      base.potDelta = potDelta.toString();
      return base;
    }

    const before = await readPool(ctx.publicClient, drawingId);
    if (before.cursor >= before.ticketCount) {
      base.outcome = "drained";
      base.potDelta = potDelta.toString();
      return base;
    }

    const remaining = Number(before.ticketCount - before.cursor);
    const n = Math.min(count, remaining);
    base.lastBatchSize = n;

    // Simulate first. This is where a named custom error is still available — once a transaction
    // is mined, a reverted receipt carries no reason at all, so skipping straight to `send` would
    // throw away the only signal that tells `not-settled` apart from `fatal`.
    let gas: bigint;
    try {
      gas = await ctx.publicClient.estimateContractGas({
        address: FARPOT_POOL_ADDRESS,
        abi: FARPOT_POOL_ABI,
        functionName: "claimBatch",
        args: [drawingId, n],
        account: ctx.account,
      });
    } catch (err) {
      const verdict = classifyCrankError(err);
      if (verdict === "drained") {
        base.potDelta = potDelta.toString();
        return base;
      }
      if (verdict === "not-settled") {
        base.outcome = "not-settled";
        base.potDelta = potDelta.toString();
        return base;
      }
      if (verdict === "underfunded") {
        // "partial", never a halt: the keeper needs funding, not a human deciding the drawing is
        // broken. Partial also stops the cursor here, so the drawing is retried next tick.
        base.outcome = "partial";
        base.reason = `keeper cannot pay for claimBatch(${drawingId}, ${n}): ${errText(err)}`;
        base.potDelta = potDelta.toString();
        return base;
      }
      if (verdict === "resize") {
        if (n === 1) {
          // Nothing left to halve. Retrying can only burn gas, so this is where the cron stops.
          base.outcome = "terminal";
          base.reason = `claimBatch(${drawingId}, 1) still fails: ${errText(err)}`;
          base.potDelta = potDelta.toString();
          return base;
        }
        count = Math.max(1, Math.floor(n / 2));
        continue;
      }
      base.outcome = "fatal";
      base.reason = errText(err);
      base.potDelta = potDelta.toString();
      return base;
    }

    // Pad the estimate, but never above what a block can actually hold.
    //
    // An unclamped pad is not merely wasteful, it is unminable: a transaction whose gas limit
    // exceeds the block gas limit can never be included, and the node rejects it with a message
    // about cost and balance that looks nothing like a size problem. Measured on a fork with the
    // limit at 400k — the padded 4-ticket batch went over and failed at submission with
    // "the total cost ... exceeds the balance of the account", despite a 10,000 ETH keeper.
    //
    // And if the bare estimate alone does not fit, no padding will help: that is a size problem,
    // so it goes back through the same halving path rather than being sent and rejected.
    const blockGasLimit = await ctx.publicClient
      .getBlock()
      .then((b) => b.gasLimit)
      .catch(() => BigInt(0));
    const padded = (gas * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
    if (blockGasLimit > BigInt(0) && gas > blockGasLimit) {
      if (n === 1) {
        base.outcome = "terminal";
        base.reason = `claimBatch(${drawingId}, 1) needs ${gas} gas but the block limit is ${blockGasLimit}`;
        base.potDelta = potDelta.toString();
        return base;
      }
      count = Math.max(1, Math.floor(n / 2));
      continue;
    }
    const gasLimit = blockGasLimit > BigInt(0) && padded > blockGasLimit ? blockGasLimit : padded;

    // Submission and mining are classified too, not just simulation.
    //
    // This is where "this call does not fit" most often actually lands: a node can happily
    // estimate a figure and then reject the transaction for exceeding the block gas limit, and
    // `waitForTransactionReceipt` can time out with the outcome genuinely unknown. Leaving these
    // to propagate would turn an ordinary resize into an unclassified crash — the cron would
    // report a generic error, never halve, and never alert either.
    let hash: Hex;
    let receipt: Awaited<ReturnType<PoolPublicClient["waitForTransactionReceipt"]>>;
    try {
      hash = await ctx.walletClient.writeContract({
        address: FARPOT_POOL_ADDRESS,
        abi: FARPOT_POOL_ABI,
        functionName: "claimBatch",
        args: [drawingId, n],
        account: ctx.account,
        chain: ctx.walletClient.chain,
        gas: gasLimit,
      });
      base.txs.push(hash);
      base.batches++;

      // A submitted transaction is not a successful one. Phase 8 lost real time to `cast send`
      // exiting 0 on a REVERTED transaction; the same trap is here, because `writeContract`
      // resolves as soon as the transaction is accepted into the mempool.
      receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    } catch (err) {
      // A receipt that never arrives is NOT a verdict about the drawing.
      //
      // Waiting without a bound is a real hazard in a cron: the function budget is fixed, so a
      // stalled poll silently eats the whole run and everything after it. But timing out must
      // not halt the drawing either — the transaction may well be mined a moment later, and the
      // next run re-reads `poolOf`, which is authoritative about what is left to claim. So this
      // is `partial`: retried, never written off.
      if (isReceiptTimeout(err)) {
        base.outcome = "partial";
        base.reason = `no receipt for ${hash!} within ${RECEIPT_TIMEOUT_MS}ms; chain state decides on the next run`;
        base.potDelta = potDelta.toString();
        return base;
      }
      // Re-read first: a stranger's claimBatch may have drained the slice while we waited, in
      // which case our failure is somebody else doing the job and not an incident at all.
      const now = await readPool(ctx.publicClient, drawingId).catch(() => null);
      if (now && now.cursor > before.cursor) continue;

      const verdict = classifyCrankError(err);
      if (verdict === "drained") {
        base.potDelta = potDelta.toString();
        return base;
      }
      if (verdict === "resize" && n > 1) {
        count = Math.max(1, Math.floor(n / 2));
        continue;
      }
      if (verdict === "underfunded") {
        base.outcome = "partial";
        base.reason = `keeper cannot pay for claimBatch(${drawingId}, ${n}): ${errText(err)}`;
        base.potDelta = potDelta.toString();
        return base;
      }
      // Same shape as `underfunded`, and for the same reason: the failure says nothing about
      // this drawing, so it must leave no halt behind. `partial` stops the cursor here, which
      // is what gets the drawing retried on the next tick rather than stepped over.
      if (verdict === "transient") {
        base.outcome = "partial";
        base.reason = `claimBatch(${drawingId}, ${n}) hit a transient network/mempool failure: ${errText(err)}`;
        base.potDelta = potDelta.toString();
        return base;
      }
      base.outcome = verdict === "resize" ? "terminal" : "fatal";
      base.reason = `claimBatch(${drawingId}, ${n}) could not be sent: ${errText(err)}`;
      base.potDelta = potDelta.toString();
      return base;
    }

    const after = await readPool(ctx.publicClient, drawingId);

    if (receipt.status !== "success") {
      if (after.cursor > before.cursor) {
        // Someone else's claimBatch landed in between and took our slice. Permissionless is the
        // point; this is progress, not a failure.
        continue;
      }
      if (looksOutOfGas(receipt.gasUsed, gasLimit)) {
        if (n === 1) {
          base.outcome = "terminal";
          base.reason = `claimBatch(${drawingId}, 1) ran out of gas (used ${receipt.gasUsed}/${gasLimit}) in ${hash}`;
          base.potDelta = potDelta.toString();
          return base;
        }
        count = Math.max(1, Math.floor(n / 2));
        continue;
      }
      base.outcome = "fatal";
      base.reason = `claimBatch(${drawingId}, ${n}) reverted on-chain in ${hash} (gasUsed ${receipt.gasUsed}/${gasLimit})`;
      base.potDelta = potDelta.toString();
      return base;
    }

    base.ticketsClaimed += Number(after.cursor - before.cursor);
    potDelta += batchPotDelta(receipt.logs, drawingId);
  }

  base.outcome = "partial";
  base.reason = `stopped after ${MAX_BATCHES_PER_DRAWING} batches`;
  base.potDelta = potDelta.toString();
  return base;
}

/**
 * Sum the `potDelta` field of this receipt's `BatchClaimed` events.
 *
 * Read from the event rather than from a balance diff: the contract simultaneously holds other
 * drawings' unclaimed pots plus rounding dust, so an external balance read would misattribute
 * them — the same reason the contract itself uses a measured delta internally.
 */
function batchPotDelta(logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[], drawingId: bigint): bigint {
  const pool = FARPOT_POOL_ADDRESS.toLowerCase();
  let total = BigInt(0);
  for (const log of logs) {
    if (log.address.toLowerCase() !== pool) continue;
    // topics[1] is the indexed drawingId; data is (count, potDelta, cursor), 32 bytes each.
    if (log.topics.length < 2) continue;
    try {
      if (BigInt(log.topics[1]) !== drawingId) continue;
      const body = log.data.slice(2);
      if (body.length < 192) continue;
      total += BigInt(`0x${body.slice(64, 128)}`);
    } catch {
      // A log we cannot parse is not worth failing a successful claim over; the on-chain pot is
      // authoritative either way and this figure is only for the run report.
    }
  }
  return total;
}

// Long enough to keep the node's own words. Truncating at 300 hid the detail line that explained
// an "insufficient funds" failure on a wallet holding 10,000 ETH, and a diagnostic that omits the
// diagnosis costs more than the bytes it saves.
const REASON_MAX = 1200;

function errText(err: unknown): string {
  const named = revertName(err);
  const parts = [err instanceof Error ? err.message : String(err)];
  // viem puts the node's verbatim error in `details`, which is usually where the real cause is.
  const details = (err as { details?: unknown })?.details;
  if (typeof details === "string" && !parts[0].includes(details)) parts.push(`details: ${details}`);
  const message = parts.join(" | ").slice(0, REASON_MAX);
  return named ? `${named}: ${message}` : message;
}

/** The drawing window a run will inspect, and which of those drawings still owe claims. */
export interface PendingScan {
  from: bigint;
  to: bigint;
  /** Every candidate in window order, so the caller can walk them and advance a cursor. */
  candidates: bigint[];
  /** Candidates with a settled ticket list the cursor has not drained. */
  pending: bigint[];
}

/**
 * Work out which settled drawings still owe claims.
 *
 * Separated from the cranking itself so that "is there anything waiting?" can be answered
 * without a keeper key, a wallet client, or any pretence of a dry run. That question has to be
 * answerable on its own, because the alert for "money is waiting and no keeper is configured"
 * depends on it.
 *
 * `cursor` comes from Redis when there is one and a bounded look-back when there is not. Either
 * way `poolOf` decides what actually needs work, so the cursor can only widen or narrow the
 * search — never cause a drawing to be skipped incorrectly.
 */
export async function findPendingDrawings(
  publicClient: PoolPublicClient,
  currentDrawingId: bigint,
  cursor: bigint | null,
): Promise<PendingScan> {
  // No cursor means start at the FIRST drawing the pool could have joined — never a recent-N
  // window. An age cutoff here is not a performance trade-off, it is data loss: `claim()` has no
  // on-chain deadline, so a drawing that fell out of the window while the cache was empty would
  // never be scanned again, and its contributors' winnings would sit uncollected forever with
  // nothing reporting it. That is the same defect Phase 8's second sweep fixed in the UI and the
  // halt set fixed in the cron; the cost of avoiding it is a few extra multicalls on a cold run.
  const floor = POOL_FIRST_DRAWING;
  let from = cursor ?? floor;
  if (from < floor) from = floor;

  // `claimBatch` reverts NotSettled for anything at or above the current drawing, so the last
  // candidate is currentDrawingId - 1. Settlement and rollover are atomic, so this IS "settled".
  const to = currentDrawingId - BigInt(1);
  if (to < from) return { from, to, candidates: [], pending: [] };

  const candidates: bigint[] = [];
  for (let d = from; d <= to && candidates.length < CRANK_SCAN_LIMIT; d++) candidates.push(d);

  const pending: bigint[] = [];
  // Chunked so a cold scan over years of history is many small requests rather than one request
  // no RPC would answer. `allowFailure: false` on purpose: a partial read would silently look
  // like "nothing to claim", which is Phase 8's finding 2 wearing a different hat — better to
  // fail the run and retry than to act confidently on an incomplete picture.
  for (let offset = 0; offset < candidates.length; offset += MULTICALL_CHUNK) {
    const chunk = candidates.slice(offset, offset + MULTICALL_CHUNK);
    const snapshots = (await publicClient.multicall({
      contracts: chunk.map((d) => ({
        address: FARPOT_POOL_ADDRESS,
        abi: FARPOT_POOL_ABI,
        functionName: "poolOf" as const,
        args: [d] as const,
      })),
      allowFailure: false,
    })) as readonly (readonly [bigint, bigint, bigint, number, bigint, bigint])[];

    for (let i = 0; i < chunk.length; i++) {
      const [, , , , cur, ticketCount] = snapshots[i];
      // Zero tickets = a drawing the pool never joined; cursor at the end = already drained.
      if (ticketCount > BigInt(0) && cur < ticketCount) pending.push(chunk[i]);
    }
  }

  return { from, to, candidates, pending };
}

/**
 * Crank every settled drawing that still has unclaimed tickets.
 */
export async function crankSettledDrawings(
  ctx: CrankContext,
  currentDrawingId: bigint,
  cursor: bigint | null,
): Promise<CrankReport> {
  const scan = await findPendingDrawings(ctx.publicClient, currentDrawingId, cursor);
  const pending = new Set(scan.pending.map((d) => d.toString()));

  const report: CrankReport = {
    from: scan.from.toString(),
    to: scan.to.toString(),
    inspected: scan.candidates.length,
    drawings: [],
    alerts: [],
    budgetExhausted: false,
    resolvedThrough: null,
  };

  for (const drawingId of scan.candidates) {
    if (!pending.has(drawingId.toString())) {
      report.resolvedThrough = drawingId.toString();
      continue;
    }

    const halt = await ctx.isHalted(drawingId);
    if (halt) {
      report.resolvedThrough = drawingId.toString();
      report.drawings.push({
        drawingId: drawingId.toString(),
        outcome: "halted",
        ticketsClaimed: 0,
        potDelta: "0",
        batches: 0,
        lastBatchSize: 0,
        txs: [],
        reason: halt,
      });
      continue;
    }

    if (Date.now() > ctx.deadline) {
      report.budgetExhausted = true;
      break;
    }

    const result = await crankDrawing(ctx, drawingId);
    report.drawings.push(result);
    report.resolvedThrough = drawingId.toString();

    if (result.outcome === "fatal" || result.outcome === "terminal") {
      const kind = result.outcome === "terminal" ? "crank-terminal" : "crank-fatal";
      // The halt has to be DURABLE before this drawing counts as dealt with. If the write fails,
      // say so on the result: the cursor then stops here instead of stepping over a jam that
      // nothing can rediscover.
      try {
        await ctx.onHalt(drawingId, kind, result.reason ?? result.outcome);
        result.haltPersisted = true;
      } catch (err) {
        result.haltPersisted = false;
        report.alerts.push({
          kind: "crank-fatal",
          key: `halt-write-${drawingId}`,
          message: `drawing ${drawingId} is jammed AND its halt could not be recorded — it will be retried rather than forgotten`,
          detail: String(err),
        });
      }
      report.alerts.push({
        kind,
        key: `drawing-${drawingId}`,
        message:
          result.outcome === "terminal"
            ? `claimBatch is failing at the minimum batch size for drawing ${drawingId} — winnings cannot be collected without a human`
            : `claimBatch reverted deterministically for drawing ${drawingId} — cranking stopped for it`,
        detail: result.reason,
      });
    }
  }

  return report;
}



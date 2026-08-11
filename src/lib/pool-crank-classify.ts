// The cron crank's PURE decision logic: how a failed `claimBatch` is classified (design §4's
// table), and how far the crank cursor may advance afterwards.
//
// Deliberately its own module with NO relative imports, so `pool-crank-proof.ts` can load it
// under `node --experimental-strip-types` and assert against the very functions the cron runs.
// The alternative — a re-typed copy of these rules in the proof — would pass happily while the
// real cron misbehaved, which is precisely the failure this file exists to prevent.
//
// The four buckets, and why halving is not the default:
//
//   resize      → out of gas / over the block limit / oversized. Halve, floor 1, retry.
//   drained     → NothingToClaim. The cursor is already at the end; SUCCESS, not an error, and
//                 the normal result of a second run over the same drawing.
//   not-settled → NotSettled. The drawing has not rolled over yet. Try again later.
//   fatal       → anything else. Alert and stop. Do NOT retry.
//
// Design round 5 finding 3 rejected "halve on any failure": a deterministic revert is usually
// not a size problem, and blind retries would mask a real fault while burning gas.

import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  type Hex,
} from "viem";

/** How a failed `claimBatch` attempt should be handled. */
export type CrankVerdict = "resize" | "not-settled" | "drained" | "fatal" | "underfunded";

// An out-of-gas keeper is NOT one of design §4's four buckets, and conflating it with them is a
// real defect rather than a tidiness point: "fatal" records a permanent halt, so a wallet that
// simply needed topping up would leave the drawing halted forever even after it was funded.
// It is transient — fix the balance and the next tick works — so it gets its own verdict and
// never halts anything.
const UNDERFUNDED_PATTERNS = ["insufficient funds", "exceeds the balance of the account"];

// Substrings that mean "this call did not fit", in the several dialects the stack speaks:
// viem's own error copy, geth/reth's JSON-RPC strings, and anvil's EVM errors. Every entry is
// anchored on a phrase that only appears for a size or gas-capacity problem — deliberately NOT
// a bare "gas", which also appears in fee-related messages that must classify as `fatal`.
export const SIZE_FAILURE_PATTERNS = [
  "out of gas",
  "outofgas",
  "intrinsic gas too high",
  "exceeds block gas limit",
  "exceeds the block gas limit",
  "gas allotted for the block",
  "gas required exceeds",
  "gas limit reached",
  "exceeds gas limit",
  "oversized data",
  "transaction too large",
];

/**
 * What a viem error chain says about a revert.
 *
 * `reverted` distinguishes "the call reverted but told us nothing" from "this was not a revert at
 * all" — a distinction the classifier depends on and which a bare name lookup collapses.
 */
export function revertInfo(err: unknown): { reverted: boolean; name: string | null } {
  if (!(err instanceof BaseError)) return { reverted: false, name: null };

  const named = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (named instanceof ContractFunctionRevertedError) {
    return { reverted: true, name: normalizeName(named.data?.errorName ?? named.reason ?? null) };
  }

  // An out-of-gas revert returns EMPTY data, so there is nothing for viem to decode into a
  // custom error and it never constructs a `ContractFunctionRevertedError` at all — the chain
  // carries a bare `ExecutionRevertedError` instead. Missing this is what made an eight-ticket
  // claim under a 400k block limit classify as `fatal` instead of resizing.
  const bare = err.walk((e) => e instanceof ExecutionRevertedError);
  if (bare instanceof ExecutionRevertedError) return { reverted: true, name: null };

  return { reverted: false, name: null };
}

/**
 * A generic "execution reverted" is not a name.
 *
 * viem sometimes populates `reason` with that phrase for an undecodable revert. Passing it
 * through would hit the classifier's "a named error we did not anticipate" branch and be called
 * fatal, when in fact it means the opposite: nothing was decodable.
 */
function normalizeName(name: string | null): string | null {
  if (!name) return null;
  return /^execution reverted\.?$/i.test(name.trim()) ? null : name;
}

/** The custom error name a viem error chain decoded, if any. */
export function revertName(err: unknown): string | null {
  return revertInfo(err).name;
}

/**
 * Sort a failed `claimBatch` into one of the four design §4 buckets.
 *
 * Named errors win over message matching, always. A contract that told us exactly what was wrong
 * must not be second-guessed by a substring search — `InvalidBatchSize` contains the word "size"
 * and would otherwise be mistaken for a gas problem and retried at ever-smaller counts, when in
 * truth it means the cron sent a count the contract rejects outright and no count will help.
 */
export function classifyCrankError(err: unknown): CrankVerdict {
  const info = revertInfo(err);
  switch (info.name) {
    case "NothingToClaim":
      return "drained";
    case "NotSettled":
      return "not-settled";
    // Our own bug: a count of 0 or above MAX_CLAIM_BATCH. Shrinking cannot fix a zero, and no
    // amount of retrying fixes a caller error, so this is fatal on purpose.
    case "InvalidBatchSize":
      return "fatal";
    case null:
      break;
    default:
      // A named error we did not anticipate is a deterministic revert by definition.
      return "fatal";
  }

  const text = (err instanceof Error ? `${err.message} ${err.stack ?? ""}` : String(err)).toLowerCase();
  // Before the size patterns: an underfunded send mentions gas costs and would otherwise be
  // halved pointlessly down to a batch of one that is just as unaffordable.
  if (UNDERFUNDED_PATTERNS.some((p) => text.includes(p))) return "underfunded";
  if (SIZE_FAILURE_PATTERNS.some((p) => text.includes(p))) return "resize";

  // A revert that decoded to NOTHING — no custom error, no reason string — is treated as a size
  // problem. Measured, not assumed: on a fork with the block gas limit at 400k, an eight-ticket
  // claim surfaced as a bare "execution reverted" with empty revert data, because gas exhaustion
  // produces no return data to decode. Only when the estimate exceeds the cap outright does the
  // node volunteer "gas required exceeds allowance", which is what the patterns above catch.
  //
  // The asymmetry is what settles it. Guessing `resize` on a genuinely deterministic revert costs
  // at most a handful of extra estimate calls before the count reaches 1 and the run raises the
  // SAME terminal alert — nothing is masked, because halving always terminates. Guessing `fatal`
  // on a real size problem halts a drawing that would have drained, stranding winnings until a
  // human intervenes. So the undecodable case resizes.
  //
  // Note this does not reopen "halve on any failure": every NAMED error above still classifies
  // deterministically, and a non-revert error still falls through to fatal.
  if (info.reverted) return "resize";

  return "fatal";
}

/**
 * Did this receipt revert because it ran out of gas?
 *
 * A reverted receipt carries no revert reason, so the only signal available is that the
 * transaction consumed essentially everything it was given. 96% is the threshold: a genuine
 * out-of-gas burns the entire limit, while a revert with a reason refunds the remainder and
 * lands well below it.
 */
export function looksOutOfGas(gasUsed: bigint, gasLimit: bigint): boolean {
  if (gasLimit === BigInt(0)) return false;
  return gasUsed * BigInt(100) >= gasLimit * BigInt(96);
}

/** What happened to one drawing on one run. */
export interface DrawingCrankResult {
  drawingId: string;
  outcome: "drained" | "partial" | "not-settled" | "halted" | "fatal" | "terminal";
  ticketsClaimed: number;
  potDelta: string;
  batches: number;
  lastBatchSize: number;
  txs: Hex[];
  reason?: string;
  /**
   * Whether this drawing's halt was durably recorded.
   *
   * `false` means the drawing is jammed AND we failed to write that down, which is strictly
   * worse than either alone: the cursor would move past it (halts do not block the cursor) while
   * `listHalts` cannot rediscover it, so its winnings would never be retried or even reported
   * again. The cursor therefore treats an unpersisted halt as unfinished — retrying a jammed
   * drawing costs a few estimate calls, whereas losing one strands real money.
   */
  haltPersisted?: boolean;
}

export interface CrankReport {
  from: string;
  to: string;
  inspected: number;
  drawings: DrawingCrankResult[];
  alerts: Array<{ kind: "crank-fatal" | "crank-terminal"; key: string; message: string; detail?: string }>;
  budgetExhausted: boolean;
  /**
   * The highest drawing this run actually finished considering.
   *
   * Load-bearing for the cursor: when the time budget cuts a run short, the drawings past the
   * break were never looked at and are absent from `drawings` entirely. Advancing the cursor on
   * "no unfinished entry" alone would read that silence as "nothing to do" and skip them
   * permanently — the same shape as the write-order hazard the scan cursor documents.
   */
  resolvedThrough: string | null;
}

/**
 * How far the cursor may advance: past the longest run of drawings that need nothing further.
 *
 * It stops at the first drawing still owing work, so a partially cranked drawing is revisited
 * next run. Halted drawings do NOT stop it — they are recorded separately and would otherwise
 * wall off every later drawing behind one jam, recreating in the cron the exact defect Phase 8's
 * second sweep fixed in the UI.
 */
export function nextCrankCursor(from: bigint, report: CrankReport): bigint {
  // Nothing was resolved, so there is nothing to learn — leave the cursor where it was.
  if (report.resolvedThrough === null) return from;

  const unfinished = new Set(
    report.drawings
      .filter(
        (d) =>
          d.outcome === "partial" ||
          d.outcome === "not-settled" ||
          // A halt we could not write down must not be walked past — see `haltPersisted`.
          d.haltPersisted === false,
      )
      .map((d) => d.drawingId),
  );

  // Never past what this run actually looked at, so a budget-truncated run re-inspects the
  // drawings it never reached.
  const ceiling = BigInt(report.resolvedThrough);
  let cursor = from;
  while (cursor <= ceiling && !unfinished.has(cursor.toString())) cursor++;
  return cursor;
}

/**
 * Which past drawings to check for an unclaimed share, and what each row should show.
 *
 * Extracted as pure functions because the defect these replace was a REACHABILITY bug, not a
 * logic bug: the tab only ever read `currentDrawingId`, which can never be `Claimable` or
 * `Settled`, so the entire claim UI was dead code that looked implemented. A test can assert
 * those states are reachable; reading the component cannot.
 */

/** Mirrors IFarpotPool.PoolState. Duplicated as a plain number union to keep this pure. */
export const POOL_STATE_NONE = 0;
export const POOL_STATE_ACCUMULATING = 1;
export const POOL_STATE_CLAIMABLE = 2;
export const POOL_STATE_SETTLED = 3;

/**
 * Past drawing ids, newest first, bounded by the lookback and floored at the first drawing the
 * pool could possibly hold tickets for.
 *
 * Excludes the current drawing: it is still Accumulating and has nothing to claim.
 */
export function poolHistoryRange(params: {
  currentDrawingId: bigint;
  firstDrawing: bigint;
  lookback: number;
}): bigint[] {
  const { currentDrawingId, firstDrawing, lookback } = params;
  const ids: bigint[] = [];
  const windowFloor = currentDrawingId - BigInt(lookback);
  const floor = windowFloor > firstDrawing ? windowFloor : firstDrawing;
  for (let d = currentDrawingId - BigInt(1); d >= floor; d -= BigInt(1)) ids.push(d);
  return ids;
}

export type PoolRowState =
  | { kind: "settling" }
  | { kind: "pending" }
  | { kind: "claimed" }
  | { kind: "claimable"; owed: bigint }
  | { kind: "no-win" };

/**
 * What a past-pool row shows.
 *
 * The load-bearing rule: a payout figure appears ONLY when the pool is `Settled`. While
 * `Claimable`, `shareOf.owed` reflects just the pot `claimBatch` has collected so far, so
 * rendering it would show a number that is wrong now and changes later.
 */
export function poolRowState(params: {
  state: number;
  owed: bigint;
  hasClaimed: boolean;
}): PoolRowState {
  const { state, owed, hasClaimed } = params;
  if (state === POOL_STATE_CLAIMABLE) return { kind: "settling" };
  if (state !== POOL_STATE_SETTLED) return { kind: "pending" };
  if (hasClaimed) return { kind: "claimed" };
  if (owed > BigInt(0)) return { kind: "claimable", owed };
  return { kind: "no-win" };
}

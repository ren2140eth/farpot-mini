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

/** What the expanded breakdown under a past-draw row renders. */
export type PoolBreakdown = {
  /** Every ticket the pool bought for the drawing — joined and sponsored alike. */
  poolTickets: bigint;
  /** `poolTickets - totalTickets`. Rendered as a suffix only when non-zero. */
  sponsoredTickets: bigint;
  /** This wallet's tickets in the class that is actually being paid. */
  myTickets: bigint;
  /** What `myTickets` is a share OF — the paying class's total, not `poolTickets`. */
  denominator: bigint;
  /** `pot * myTickets / denominator`. */
  share: bigint;
  /**
   * How many of the pool's tickets won, or `null` when the lookup failed.
   *
   * Carried through rather than counted here — the count comes from the Megapot API, not the
   * chain. It rides along so the "never substitute zero" rule below is assertable.
   */
  winningTickets: number | null;
};

/**
 * The arithmetic behind one past draw: what the pool bought, what it won, and how the pot
 * divides down to this wallet.
 *
 * Returns `null` for any state but `Settled`, which is what keeps the panel honest. While
 * `Claimable` the pot is still draining and every figure derived from it is a number that is
 * wrong now and changes later — the same rule `poolRowState` enforces for the row itself.
 *
 * The share is RECOMPUTED here rather than read from `shareOf.owed`, because `owed` is zeroed
 * the moment `hasClaimed` flips. A claimed row has no payout left to read, and showing the
 * user nothing is how the money disappeared from the UI in the first place. Integer division
 * on bigints floors, which is exactly what the contract's `fullMulDiv` does.
 */
export function poolBreakdown(params: {
  kind: "joiner" | "sponsor";
  state: number;
  /** `poolOf.ticketCount` — the length of the drawing's ticket-id array. */
  ticketCount: bigint;
  /** `poolOf.tickets` — joiner weight only, excluding sponsored tickets. */
  totalTickets: bigint;
  /** `poolOf.potAmount` — the measured USDC `claimBatch` collected. */
  pot: bigint;
  myTickets: bigint;
  winningTickets: number | null;
}): PoolBreakdown | null {
  const { kind, state, ticketCount, totalTickets, pot, myTickets, winningTickets } = params;
  if (state !== POOL_STATE_SETTLED) return null;

  const sponsoredTickets = ticketCount - totalTickets;
  // A sponsor row is only ever paid in the zero-joiner fallback, where the contract divides by
  // `totalSponsored`. There is no `totalSponsored` in `poolOf`, but the pool's tickets are
  // exactly its joined plus its sponsored ones, so the difference IS that figure — and in the
  // fallback itself (`totalTickets == 0`) it collapses to the whole ticket count.
  //
  // The `totalTickets != 0` gate is load-bearing and mirrors `sponsorShareOf` exactly: ANY
  // joiner weight means the sponsor class is owed nothing, because the pot goes to the joiners.
  // Without it a sponsor who sat out a drawing other people joined divides the pot by the
  // sponsored tickets alone and is shown most of it — money that is not theirs. That row is
  // reachable: `mySponsoredPools` gates on this WALLET having no joiner tickets, not on the
  // POOL having none.
  const sponsorClassPays = kind === "sponsor" && totalTickets === BigInt(0);
  const denominator = kind === "sponsor" ? sponsoredTickets : totalTickets;
  const payable = kind === "joiner" || sponsorClassPays;

  return {
    poolTickets: ticketCount,
    sponsoredTickets,
    myTickets,
    denominator,
    // Guarded so a drawing with no paying class returns 0 rather than dividing by zero.
    share: !payable || denominator === BigInt(0) ? BigInt(0) : (pot * myTickets) / denominator,
    winningTickets,
  };
}

/**
 * How many tickets a wallet may add to the pool in one join.
 *
 * Two independent limits apply and the smaller wins:
 *
 *   1. `contractCap` — `MAX_TICKETS_PER_JOIN`, read from the contract so the UI and the
 *      constant can never diverge. Gas-bound and per transaction, not a pool-size limit.
 *   2. The soft-launch cap on TOTAL pool size per drawing. Advisory only: the contract has no
 *      total cap, `join()` is callable directly, and two people can pass this check in the
 *      same block. It bounds the routine case until the audit; it is not a guarantee, and the
 *      copy must never present it as one.
 *
 * Extracted from the component so the boundary behaviour can be tested against the SAME code
 * the UI runs, rather than a re-typed copy of it that could drift.
 */
export function poolJoinLimits(params: {
  /** Tickets already in this drawing's pool, from `poolOf`. */
  poolTickets: bigint;
  /** Live ticket price from `getDrawingState` — never assume $1; it is a chain value. */
  ticketPrice: bigint;
  /** `MAX_TICKETS_PER_JOIN`, read from the contract. */
  contractCap: bigint;
  /** The soft-launch cap in USDC. Passed in rather than imported so this module stays
   *  dependency-free and can be exercised directly by the boundary proof. */
  softCapUsdc: bigint;
}): { poolValueUsdc: bigint; headroomUsdc: bigint; maxThisJoin: number; atCap: boolean } {
  const { poolTickets, ticketPrice, contractCap, softCapUsdc } = params;

  const poolValueUsdc = poolTickets * ticketPrice;

  // Clamped at zero, never negative. The pool can legitimately sit ABOVE the cap, and a
  // negative headroom would flow straight into a negative stepper maximum.
  const headroomUsdc = poolValueUsdc >= softCapUsdc ? BigInt(0) : softCapUsdc - poolValueUsdc;

  // A zero price would divide by zero. It also means the drawing state has not loaded yet, so
  // the honest answer is "no joins allowed" rather than an unbounded stepper.
  const headroomTickets = ticketPrice > BigInt(0) ? headroomUsdc / ticketPrice : BigInt(0);

  const maxThisJoin = Number(headroomTickets < contractCap ? headroomTickets : contractCap);
  return { poolValueUsdc, headroomUsdc, maxThisJoin, atCap: maxThisJoin <= 0 };
}

/**
 * How many tickets a wallet may SPONSOR in one transaction.
 *
 * Identical shape to `poolJoinLimits`, against a separate budget: sponsored value has its own
 * soft cap so a sponsorship cannot consume the joiners' headroom. Same two limits, smaller
 * wins, same advisory-only caveat — `sponsor()` is callable directly and the contract has no
 * total cap.
 */
export function poolSponsorLimits(params: {
  /** Tickets already sponsored for this drawing, from `sponsorsOf`. */
  sponsoredTickets: bigint;
  ticketPrice: bigint;
  contractCap: bigint;
  softCapUsdc: bigint;
}): { sponsoredValueUsdc: bigint; headroomUsdc: bigint; maxThisSponsor: number; atCap: boolean } {
  const { sponsoredTickets, ticketPrice, contractCap, softCapUsdc } = params;

  const sponsoredValueUsdc = sponsoredTickets * ticketPrice;
  const headroomUsdc =
    sponsoredValueUsdc >= softCapUsdc ? BigInt(0) : softCapUsdc - sponsoredValueUsdc;
  const headroomTickets = ticketPrice > BigInt(0) ? headroomUsdc / ticketPrice : BigInt(0);

  const maxThisSponsor = Number(headroomTickets < contractCap ? headroomTickets : contractCap);
  return { sponsoredValueUsdc, headroomUsdc, maxThisSponsor, atCap: maxThisSponsor <= 0 };
}

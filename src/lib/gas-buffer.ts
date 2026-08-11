/**
 * Pad an `eth_estimateGas` result before signing.
 *
 * `eth_estimateGas` is a lower bound measured against the state at estimation time, not a
 * promise about the state the transaction actually lands in. Every write path in this app
 * that touches Megapot goes through `buyTickets`, whose cost is dominated by storage writes
 * whose price depends on the slot's prior value (20k for zero→nonzero, 5k for nonzero→nonzero).
 * Another buyer landing between the estimate and the mine is enough to push the real cost above
 * the estimate — and a transaction that runs out of gas burns its ENTIRE limit and reverts, so
 * the user pays full freight for nothing.
 *
 * This has now bitten the project three times, which is why it lives in one place:
 *   1. The solo buy path (tx c903…b6fd on Base) — fixed with 1.5x, inline.
 *   2. The keeper's `claimBatch` (found on an anvil OP-stack fork) — fixed with 1.3x, inline.
 *   3. The pooled `join` (tx 0x5f0d…a7b9 on Base, 2026-08-11) — sent the bare estimate with no
 *      padding, consumed exactly its 1,247,168 limit and reverted. Re-estimating the identical
 *      call minutes later returned 1,266,039, i.e. the estimate itself had moved 1.5% in the
 *      time it took to sign.
 *
 * 1.5x, matching the most conservative existing call site. Over-padding is close to free on
 * Base: gas is billed on what a transaction USES, not on its limit. The only real cost is that
 * the wallet must hold `limit x gasPrice` up front, which at Base's sub-gwei prices is cents.
 * Under-padding costs the user the whole failed transaction.
 */
export const GAS_BUFFER_NUMERATOR = BigInt(3);
export const GAS_BUFFER_DENOMINATOR = BigInt(2);

export function bufferGas(estimate: bigint): bigint {
  // Pure BigInt math throughout: a non-integer reaching BigInt() throws RangeError, which
  // would crash the transaction before it ever reached the wallet.
  return (estimate * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {FarpotPool} from "../src/FarpotPool.sol";
import {IFarpotPool} from "../src/interfaces/IFarpotPool.sol";
import {FarpotPoolHandler} from "./handlers/FarpotPoolHandler.sol";
import {MockJackpot} from "./mocks/MockJackpot.sol";
import {MockRandomTicketBuyer} from "./mocks/MockRandomTicketBuyer.sol";
import {MockTicketNFT} from "./mocks/MockTicketNFT.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Invariants I1–I12 from design §4.3 over arbitrary interleavings of
///         `join` / `sponsor` / `claimBatch` / `claim` / rollover.
/// @dev This suite is the only artefact that would automatically have caught the
///      accounting-shaped defects five design review rounds found by inspection. Every
///      invariant below is checked against OBSERVABLE state — the NFT's ownership and the
///      pool's public getters — never against raw storage slots, so a Phase 4 layout change
///      cannot make one silently vacuous.
contract FarpotPoolInvariantsTest is Test {
    MockUSDC internal usdc;
    MockTicketNFT internal nft;
    MockJackpot internal jackpot;
    MockRandomTicketBuyer internal rtb;
    FarpotPool internal pool;
    FarpotPoolHandler internal handler;

    address internal constant REFERRAL = address(0xBEEF);
    uint256 internal constant D0 = 129;

    function setUp() public {
        usdc = new MockUSDC();
        jackpot = new MockJackpot(address(0), address(usdc), D0);
        nft = new MockTicketNFT(address(jackpot));
        jackpot.setJackpotNFT(address(nft));
        rtb = new MockRandomTicketBuyer(address(jackpot), address(usdc));
        jackpot.setAuthorizedMinter(address(rtb), true);

        pool = new FarpotPool(address(jackpot), address(rtb), address(nft), address(usdc), REFERRAL);
        // The pool deploys paused (see FarpotPool's constructor); the fuzzer exercises the live pool.
        pool.unpause();
        usdc.mint(address(jackpot), 100_000_000e6); // deep enough to pay any fuzzed win

        handler = new FarpotPoolHandler(pool, jackpot, nft, rtb, usdc);
        targetContract(address(handler));
    }

    /*//////////////////////////////////////////////////////////////
                              I1 – I3, I6
    //////////////////////////////////////////////////////////////*/

    /// @dev I1: the recorded id list and the two ticket counters can never disagree. Sponsored
    ///      tickets are in the list but NOT in `totalTickets`, so the sum is the property —
    ///      and this is what catches a sponsor being wrongly credited payout weight.
    function invariant_I1_ticketIdsLengthMatchesTotalTickets() public view {
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            (,,,,, uint256 ticketCount) = pool.poolOf(d);
            assertEq(ticketCount, pool.totalTickets(d) + pool.totalSponsored(d), "I1");
        }
    }

    /// @dev I2: per-user weights must sum to the drawing total, or shares are mispriced.
    function invariant_I2_userWeightsSumToTotal() public view {
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            uint256 sum;
            for (uint256 a; a < handler.actorCount(); ++a) {
                sum += pool.ticketsByUser(d, handler.actors(a));
            }
            assertEq(sum, pool.totalTickets(d), "I2");
        }
    }

    /// @dev I3: every ticket the pool holds for a drawing is recorded, and the recorded count
    ///      matches the list length — so no id was double-counted.
    ///
    ///      This is the ONE invariant that needs a full token sweep, and it is checked in
    ///      `afterInvariant` rather than after every call. Run per-call it is
    ///      O(drawings x every token ever minted), which made the campaign quadratic and
    ///      un-runnable at a depth deep enough to walk two pool lifecycles — so the cost of
    ///      keeping it per-call was a SHALLOWER campaign, which is a worse trade. Everything
    ///      else here is O(drawings x actors) and stays per-call.
    function _assertI3() internal view {
        uint256 len = nft.allTokensLength();
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            uint256 recorded;
            for (uint256 t; t < len; ++t) {
                uint256 id = nft.tokenAt(t);
                if (nft.getTicketInfo(id).drawingId != d) continue;
                if (pool.recordedTicket(id)) ++recorded;
            }
            (,,,,, uint256 ticketCount) = pool.poolOf(d);
            assertEq(recorded, ticketCount, "I3");
        }
    }

    /// @dev I6: the contributor counter must match the set of non-zero weights, or the UI
    ///      reports a pool size nobody is actually in.
    function invariant_I6_contributorCountMatchesNonZeroWeights() public view {
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            uint256 n;
            for (uint256 a; a < handler.actorCount(); ++a) {
                if (pool.ticketsByUser(d, handler.actors(a)) > 0) ++n;
            }
            assertEq(n, pool.contributorCount(d), "I6");
        }
    }

    /// @dev I2s: sponsored weights must sum to the sponsored total, or fallback shares are
    ///      mispriced exactly the way I2 guards the joiner path.
    function invariant_I2s_sponsorWeightsSumToTotal() public view {
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            uint256 sum;
            for (uint256 a; a < handler.actorCount(); ++a) {
                sum += pool.sponsoredByUser(d, handler.actors(a));
            }
            assertEq(sum, pool.totalSponsored(d), "I2s");
        }
    }

    function invariant_I6s_sponsorCountMatchesNonZeroWeights() public view {
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            uint256 n;
            for (uint256 a; a < handler.actorCount(); ++a) {
                if (pool.sponsoredByUser(d, handler.actors(a)) > 0) ++n;
            }
            assertEq(n, pool.sponsorCount(d), "I6s");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                I4, I9, I10
    //////////////////////////////////////////////////////////////*/

    /// @dev I4, scoped to the unclaimed tail. Claiming burns the NFTs, so tokens below the
    ///      cursor have no owner at all — the property is "every not-yet-claimed recorded
    ///      ticket is owned by the pool", which is exactly what `claimBatch` needs to be
    ///      true of the slice it is about to submit.
    function invariant_I4_unclaimedTailIsOwnedByThePool() public view {
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            (,,,, uint256 cursor, uint256 ticketCount) = pool.poolOf(d);
            assertEq(nft.balanceOfDrawing(address(pool), d), ticketCount - cursor, "I4");
        }
    }

    function invariant_I9_cursorNeverExceedsLength() public view {
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            (,,,, uint256 cursor, uint256 ticketCount) = pool.poolOf(d);
            assertLe(cursor, ticketCount, "I9");
        }
    }

    /// @dev I10 is the TIGHT form of I9: `<=` alone would not catch a `Settled` reading
    ///      produced by anything other than a fully drained cursor, and it pins the
    ///      `length > 0` half so an untouched drawing can never present as `Settled`.
    function invariant_I10_settledImpliesDrainedAndNonEmpty() public view {
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            if (pool.poolStateOf(d) != IFarpotPool.PoolState.Settled) continue;
            (,,,, uint256 cursor, uint256 ticketCount) = pool.poolOf(d);
            assertEq(cursor, ticketCount, "I10 cursor");
            assertGt(ticketCount, 0, "I10 non-empty");
        }
    }

    /*//////////////////////////////////////////////////////////////
                             I5 & I7 — SOLVENCY
    //////////////////////////////////////////////////////////////*/

    /// @dev I5: floor division must keep the sum of payouts for a drawing at or below its
    ///      pot, for EVERY claim ordering the fuzzer produces.
    function invariant_I5_payoutsNeverExceedTheDrawingPot() public view {
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            assertLe(handler.ghostPaidPerDrawing(d), pool.pot(d), "I5");
        }
    }

    /// @dev I7 is the global solvency property and the one that matters most: several pots
    ///      share ONE USDC balance, so I5's per-drawing bound is necessary but not
    ///      sufficient. The fuzzer routinely leaves multiple drawings' pots unclaimed at
    ///      once, which is precisely the case a per-drawing bound cannot catch.
    function invariant_I7_balanceCoversEveryUnclaimedEntitlement() public view {
        uint256 owedTotal;
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            uint256 total = pool.totalTickets(d);
            // Class selection mirrors `claim`. Skipping `total == 0` (as this did before
            // sponsors existed) would skip every sponsor-only pot — the one path most in
            // need of a solvency proof.
            bool toSponsors = total == 0;
            uint256 denom = toSponsors ? pool.totalSponsored(d) : total;
            if (denom == 0) continue;
            uint256 potAmount = pool.pot(d);
            for (uint256 a; a < handler.actorCount(); ++a) {
                address who = handler.actors(a);
                if (pool.claimed(d, who)) continue;
                uint256 w = toSponsors ? pool.sponsoredByUser(d, who) : pool.ticketsByUser(d, who);
                if (w == 0) continue;
                owedTotal += FixedPointMathLib.fullMulDiv(potAmount, w, denom);
            }
        }
        assertGe(usdc.balanceOf(address(pool)), owedTotal, "I7 insolvent");
    }

    /*//////////////////////////////////////////////////////////////
                                    I8
    //////////////////////////////////////////////////////////////*/

    /// @dev I8 is vacuous by construction now that the lifecycle is derived. It stays as a
    ///      REGRESSION GUARD: if anyone reintroduces a stored `state` mapping, this becomes
    ///      a real assertion and fails the moment the stored value drifts from the
    ///      protocol's own view.
    function invariant_I8_derivedStateMatchesItsInputs() public view {
        uint256 cur = jackpot.currentDrawingId();
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            (,,,, uint256 cursor, uint256 ticketCount) = pool.poolOf(d);
            IFarpotPool.PoolState s = pool.poolStateOf(d);

            if (d == cur) {
                assertEq(uint8(s), uint8(IFarpotPool.PoolState.Accumulating), "I8 current");
            } else if (d > cur) {
                assertEq(uint8(s), uint8(IFarpotPool.PoolState.None), "I8 future");
            } else if (ticketCount == 0) {
                assertEq(uint8(s), uint8(IFarpotPool.PoolState.None), "I8 never joined");
            } else if (cursor < ticketCount) {
                assertEq(uint8(s), uint8(IFarpotPool.PoolState.Claimable), "I8 claimable");
            } else {
                assertEq(uint8(s), uint8(IFarpotPool.PoolState.Settled), "I8 settled");
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                           I11 & I12 — SPONSORS
    //////////////////////////////////////////////////////////////*/

    /// @dev I11: exactly one claimant class is active per drawing, selected SOLELY by
    ///      `totalTickets == 0` — and if there is money to pay and someone unclaimed to pay
    ///      it to, the active class must actually be owed something.
    ///
    ///      The liveness half is not decoration. Stated only as "one class is owed zero", the
    ///      invariant is satisfied by an implementation that owes EVERYONE zero and strands
    ///      the whole pot — which is the exact bug it exists to catch, and which I7 would also
    ///      pass because I7 only asserts the balance covers liabilities it can see.
    function invariant_I11_exactlyOneClaimantClassIsActive() public view {
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            bool toSponsors = pool.totalTickets(d) == 0;
            uint256 activeUnclaimedWeight;
            uint256 activeOwed;

            for (uint256 a; a < handler.actorCount(); ++a) {
                address who = handler.actors(a);
                (, uint256 joinerOwed,) = pool.shareOf(d, who);
                (, uint256 sponsorOwed,) = pool.sponsorShareOf(d, who);

                if (toSponsors) {
                    assertEq(joinerOwed, 0, "I11 inactive joiner owed");
                    activeOwed += sponsorOwed;
                    if (!pool.claimed(d, who)) activeUnclaimedWeight += pool.sponsoredByUser(d, who);
                } else {
                    assertEq(sponsorOwed, 0, "I11 inactive sponsor owed");
                    activeOwed += joinerOwed;
                    if (!pool.claimed(d, who)) activeUnclaimedWeight += pool.ticketsByUser(d, who);
                }
            }

            // Liveness: money + an unclaimed claimant must imply a non-zero entitlement.
            // Guarded on the pot being big enough that floor division cannot legitimately
            // round every share to zero.
            //
            // The comparison is against the DENOMINATOR, because the denominator is what
            // divides. Guarding on `pot >= activeUnclaimedWeight` instead is not equivalent
            // and fires on legitimate dust: partial claims shrink the unclaimed weight while
            // the divisor stays put, so the two stop tracking each other. Measured repro
            // (drawing 132, seed 11): pot = 1 wei, totalTickets = 11, one joiner already
            // claimed with weight 10, one unclaimed with weight 1. `pot(1) >= unclaimed(1)`
            // held, but the real share is floor(1 * 1 / 11) = 0 — a 1-wei pot simply cannot
            // pay an 11-ticket denominator, and every claimant on that drawing correctly got
            // zero. `pot >= denom` is the condition that actually implies a payable share:
            // it makes one unit of weight worth at least 1 wei, so ANY non-zero unclaimed
            // weight must be owed something. The liveness half stays fully real — an
            // implementation that owes everyone zero while holding a payable pot still fails
            // here, which is the bug this clause exists to catch.
            uint256 denom = toSponsors ? pool.totalSponsored(d) : pool.totalTickets(d);
            if (denom > 0 && pool.pot(d) >= denom && activeUnclaimedWeight > 0) {
                assertGt(activeOwed, 0, "I11 pot is stranded - nobody is owed it");
            }
        }
    }

    /// @dev I12: conservation. What has been paid plus what is still owed can never exceed the
    ///      pot, across every claim ordering the fuzzer produces. This is the property that
    ///      distinguishes intended floor-division dust from a leak.
    function invariant_I12_paidPlusOwedNeverExceedsPot() public view {
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            bool toSponsors = pool.totalTickets(d) == 0;
            uint256 owed;
            for (uint256 a; a < handler.actorCount(); ++a) {
                address who = handler.actors(a);
                if (pool.claimed(d, who)) continue;
                (, uint256 amount,) = toSponsors ? pool.sponsorShareOf(d, who) : pool.shareOf(d, who);
                owed += amount;
            }
            assertLe(handler.ghostPaidPerDrawing(d) + owed, pool.pot(d), "I12");
        }
    }

    /*//////////////////////////////////////////////////////////////
                             COVERAGE FLOOR
    //////////////////////////////////////////////////////////////*/

    /// @dev Runs once after all fuzz runs. Without this, a harness that stopped reaching
    ///      `claim` — because a guard started returning early for every input — would keep
    ///      every invariant above green while exploring almost none of the state space.
    ///      A silent collapse in coverage is the failure mode `fail_on_revert = false` is
    ///      famous for hiding, so it is asserted rather than eyeballed.
    ///
    ///      Floors are deliberately far below what a healthy run produces; they are a smoke
    ///      alarm, not a performance target. They were CALIBRATED FROM MEASUREMENT, not
    ///      guessed: the first set was picked blind and turned out to assume the counters
    ///      accumulate across the whole campaign. They do not — foundry resets state between
    ///      invariant runs, so `afterInvariant` sees one run's worth of `depth` calls. The
    ///      numbers below sit at roughly half of what a healthy run was measured to reach,
    ///      which leaves room for seed variation without going quiet on a real collapse.
    function afterInvariant() public view {
        _assertI3();

        assertGe(handler.okJoin(), 10, "coverage: join never exercised");
        assertGe(handler.okRollover(), 1, "coverage: no drawing ever settled");
        assertGe(handler.okMarkWinners(), 1, "coverage: pots were always zero, so I5/I7 proved nothing");
        assertGe(handler.okClaimBatch(), 2, "coverage: claimBatch never exercised");
        assertGe(handler.okClaim(), 1, "coverage: claim never reached");
        // okClaim alone is satisfiable entirely by fallback claims (the handler can spend a
        // whole run chasing the sponsor-only lane once it starts biting), which would leave
        // the ordinary joiner path — most of what `claim` does — completely unexercised while
        // every floor above stayed green. Require at least one claim NOT accounted for by the
        // fallback counter, i.e. at least one genuine joiner-class claim.
        assertGe(
            handler.okClaim() - handler.okSponsorFallbackClaim(),
            1,
            "coverage: claim never reached via the ordinary joiner class"
        );
        assertGe(handler.distinctFundedDrawings(), 1, "coverage: no drawing was ever funded");
        assertGe(handler.maxCoexistingUnclaimedPots(), 1, "coverage: no pot was ever left unclaimed");

        assertGe(handler.okSponsor(), 5, "coverage: sponsor never exercised");
        assertGe(handler.okSponsorOnlyDrawings(), 1, "coverage: no sponsor-only drawing was ever built");
        assertGe(handler.okSponsorFallbackClaim(), 1, "coverage: the sponsor fallback claim never paid");

        // NOTE ON WHY THESE ARE LOW. An earlier version demanded two COEXISTING funded pots
        // here, to force I7 to test cross-pot solvency rather than collapsing into I5. That
        // was the right requirement in the wrong place: foundry resets state between invariant
        // runs, so `afterInvariant` sees a single run's random walk, and whether one run builds
        // two coexisting pots was measured swinging between 1 and 3 depending only on the
        // fuzz seed. Enforcing it here bought flaky CI, not coverage.
        //
        // The requirement did not go away — it moved to
        // `test_I7_twoFundedPotsCoexistUnclaimed_balanceCoversBoth`, which CONSTRUCTS two
        // simultaneous unclaimed pots and asserts global solvency across them on every run.
        // A specific required scenario belongs in a deterministic test; the fuzzer's job here
        // is breadth, and the floor's job is to notice if that breadth ever collapses to
        // nothing — which is exactly what it caught when all ten invariants passed green
        // against a do-nothing skeleton.
    }
}

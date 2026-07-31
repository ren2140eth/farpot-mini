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

/// @notice Invariants I1–I10 from design §4.3 over arbitrary interleavings of
///         `join` / `claimBatch` / `claim` / rollover.
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
        usdc.mint(address(jackpot), 100_000_000e6); // deep enough to pay any fuzzed win

        handler = new FarpotPoolHandler(pool, jackpot, nft, rtb, usdc);
        targetContract(address(handler));
    }

    /*//////////////////////////////////////////////////////////////
                              I1 – I3, I6
    //////////////////////////////////////////////////////////////*/

    /// @dev I1: the recorded id list and the ticket counter can never disagree.
    function invariant_I1_ticketIdsLengthMatchesTotalTickets() public view {
        for (uint256 i; i < handler.touchedCount(); ++i) {
            uint256 d = handler.touchedDrawings(i);
            (,,,,, uint256 ticketCount) = pool.poolOf(d);
            assertEq(ticketCount, pool.totalTickets(d), "I1");
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

    /// @dev I3: every ticket the pool holds for a drawing is recorded, and the recorded
    ///      count matches the list length — so no id was double-counted.
    function invariant_I3_recordedTicketsAreUniqueAndComplete() public view {
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
            if (total == 0) continue;
            uint256 potAmount = pool.pot(d);
            for (uint256 a; a < handler.actorCount(); ++a) {
                address who = handler.actors(a);
                if (pool.claimed(d, who)) continue;
                uint256 w = pool.ticketsByUser(d, who);
                if (w == 0) continue;
                owedTotal += FixedPointMathLib.fullMulDiv(potAmount, w, total);
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
                             COVERAGE FLOOR
    //////////////////////////////////////////////////////////////*/

    /// @dev Runs once after all fuzz runs. Without this, a harness that stopped reaching
    ///      `claim` — because a guard started returning early for every input — would keep
    ///      every invariant above green while exploring almost none of the state space.
    ///      A silent collapse in coverage is the failure mode `fail_on_revert = false` is
    ///      famous for hiding, so it is asserted rather than eyeballed.
    ///
    ///      Floors are deliberately far below what a healthy run produces; they are a
    ///      smoke alarm, not a performance target.
    function afterInvariant() public view {
        assertGe(handler.okJoin(), 20, "coverage: join never exercised enough");
        assertGe(handler.okRollover(), 3, "coverage: drawings never settled");
        assertGe(handler.okMarkWinners(), 3, "coverage: pots were always zero, so I5/I7 proved nothing");
        assertGe(handler.okClaimBatch(), 10, "coverage: claimBatch never exercised enough");
        assertGe(handler.okClaim(), 5, "coverage: claim never reached");
    }
}

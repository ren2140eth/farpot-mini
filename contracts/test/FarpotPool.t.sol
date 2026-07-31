// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

import {FarpotPool} from "../src/FarpotPool.sol";
import {IFarpotPool} from "../src/interfaces/IFarpotPool.sol";
import {IJackpot} from "../src/interfaces/IJackpot.sol";
import {PoolTestBase} from "./PoolTestBase.sol";
import {MockJackpot} from "./mocks/MockJackpot.sol";
import {MockRandomTicketBuyer} from "./mocks/MockRandomTicketBuyer.sol";
import {MockTicketNFT} from "./mocks/MockTicketNFT.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/*//////////////////////////////////////////////////////////////////////////////
                                    JOIN
//////////////////////////////////////////////////////////////////////////////*/

contract FarpotPoolJoinTest is PoolTestBase {
    function test_join_happyPath_recordsEverything() public {
        _join(alice, 3);

        assertEq(pool.ticketsByUser(D0, alice), 3, "weight");
        assertEq(pool.totalTickets(D0), 3, "total");
        assertEq(pool.contributorCount(D0), 1, "contributors");
        assertEq(_poolOwnedTickets(D0), 3, "pool owns every minted ticket");

        (,,,,, uint256 ticketCount) = pool.poolOf(D0);
        assertEq(ticketCount, 3, "ticketIds length");
    }

    function test_join_passesReferralWalletAndPoolAsRecipient() public {
        _join(alice, 2);

        assertEq(rtb.lastRecipient(), address(pool), "recipient must be the pool, not the joiner");
        address[] memory refs = rtb.getLastReferrers();
        uint256[] memory split = rtb.getLastReferralSplit();
        assertEq(refs.length, 1, "one referrer");
        assertEq(refs[0], REFERRAL, "referral wallet present - this is the revenue path");
        assertEq(split.length, 1, "one split");
        assertEq(split[0], 1e18, "100% to the referral wallet");
        assertEq(rtb.lastSource(), SOURCE, "source tag");
    }

    function test_join_pullsExactCostFromJoiner() public {
        uint256 before = usdc.balanceOf(alice);
        _join(alice, 4);
        assertEq(before - usdc.balanceOf(alice), 4 * PRICE, "exact cost");
        assertEq(usdc.balanceOf(address(pool)), 0, "pool holds no unspent contribution");
    }

    /// @dev Reads the live price rather than assuming $1 — the design forbids hardcoding it.
    function test_join_usesLivePriceNotAHardcodedOne() public {
        jackpot.setTicketPrice(D0, 2_500_000); // $2.50
        uint256 before = usdc.balanceOf(alice);
        _join(alice, 2);
        assertEq(before - usdc.balanceOf(alice), 5_000_000, "priced from drawing state");
    }

    function test_join_repeatJoins_incrementWeightNotContributorCount() public {
        _join(alice, 2);
        _join(alice, 3);

        assertEq(pool.ticketsByUser(D0, alice), 5, "weight accumulates");
        assertEq(pool.totalTickets(D0), 5, "total accumulates");
        assertEq(pool.contributorCount(D0), 1, "still one contributor");
    }

    function test_join_distinctJoiners_incrementContributorCount() public {
        _join(alice, 1);
        _join(bob, 1);
        _join(carol, 2);

        assertEq(pool.contributorCount(D0), 3, "three contributors");
        assertEq(pool.totalTickets(D0), 4, "four tickets");
    }

    function test_join_emitsJoined() public {
        vm.expectEmit(true, true, true, true, address(pool));
        emit IFarpotPool.Joined(D0, alice, 3, 3);
        _join(alice, 3);
    }

    function test_join_recordsEveryTicketId() public {
        _join(alice, 3);
        uint256 recorded;
        for (uint256 i; i < nft.allTokensLength(); ++i) {
            if (pool.recordedTicket(nft.tokenAt(i))) ++recorded;
        }
        assertEq(recorded, 3, "every minted id recorded");
    }

    /*//////////////////////////////////////////////////////////////
                            CAP BOUNDARIES
    //////////////////////////////////////////////////////////////*/

    function test_join_zeroTickets_reverts() public {
        vm.prank(alice);
        vm.expectRevert(IFarpotPool.InvalidTicketCount.selector);
        pool.join(0);
    }

    function test_join_oneTicket_succeeds() public {
        _join(alice, 1);
        assertEq(pool.totalTickets(D0), 1);
    }

    /// @dev Reads the cap FROM the contract, so if Phase 5's gas gate lowers it these
    ///      boundaries track it instead of silently testing a stale number.
    function test_join_exactlyAtCap_succeeds() public {
        _join(alice, _cap());
        assertEq(pool.totalTickets(D0), _cap());
    }

    function test_join_oneOverCap_reverts() public {
        vm.prank(alice);
        vm.expectRevert(IFarpotPool.InvalidTicketCount.selector);
        pool.join(_cap() + 1);
    }

    function test_join_uint32Max_reverts() public {
        vm.prank(alice);
        vm.expectRevert(IFarpotPool.InvalidTicketCount.selector);
        pool.join(type(uint32).max);
    }

    /*//////////////////////////////////////////////////////////////
                          LOCK & ALLOWANCE
    //////////////////////////////////////////////////////////////*/

    function test_join_whileDrawingLocked_revertsPoolLocked() public {
        jackpot.setJackpotLock(D0, true);
        vm.prank(alice);
        vm.expectRevert(IFarpotPool.PoolLocked.selector);
        pool.join(1);
    }

    function test_join_leavesZeroAllowanceToTheBuyer() public {
        _join(alice, 5);
        assertEq(usdc.allowance(address(pool), address(rtb)), 0, "never a standing grant");
    }

    function test_join_allowanceResidue_reverts() public {
        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.AllowanceResidue);
        vm.prank(alice);
        vm.expectRevert(IFarpotPool.AllowanceResidue.selector);
        pool.join(3);
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                        ADVERSARIAL BUYER RESPONSES

  Megapot's ids are unique by construction, so a fork test can never produce any
  of these. They are reachable only through the mock — and if the pool did not
  validate, a duplicate would over-credit shares and then permanently jam the
  claim cursor, which is unrecoverable by design.
//////////////////////////////////////////////////////////////////////////////*/

contract FarpotPoolAdversarialTest is PoolTestBase {
    function test_duplicateIdWithinOneResponse_reverts() public {
        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.DuplicateInResponse);
        vm.prank(alice);
        vm.expectRevert(IFarpotPool.DuplicateTicket.selector);
        pool.join(4);
    }

    function test_idAlreadyRecordedByAnEarlierJoin_reverts() public {
        _join(alice, 2);

        uint256[] memory previous = new uint256[](2);
        uint256 found;
        for (uint256 i; i < nft.allTokensLength() && found < 2; ++i) {
            uint256 id = nft.tokenAt(i);
            if (pool.recordedTicket(id)) previous[found++] = id;
        }
        assertEq(found, 2, "fixture: need two recorded ids");

        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.ReplayIds);
        rtb.setReplayIds(previous);

        vm.prank(bob);
        vm.expectRevert(IFarpotPool.DuplicateTicket.selector);
        pool.join(2);
    }

    function test_foreignOwnedId_reverts() public {
        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.ForeignOwner);
        rtb.setForeignOwner(outsider);
        rtb.setForeignIndex(0);

        vm.prank(alice);
        vm.expectRevert(IFarpotPool.InvalidTicketOwner.selector);
        pool.join(3);
    }

    function test_shortArray_revertsMintCountMismatch() public {
        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.ShortArray);
        vm.prank(alice);
        vm.expectRevert(IFarpotPool.MintCountMismatch.selector);
        pool.join(3);
    }

    function test_longArray_revertsMintCountMismatch() public {
        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.LongArray);
        vm.prank(alice);
        vm.expectRevert(IFarpotPool.MintCountMismatch.selector);
        pool.join(3);
    }

    function test_idsSpanningTwoDrawings_revertsMixedDrawing() public {
        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.MixedDrawing);
        vm.prank(alice);
        vm.expectRevert(IFarpotPool.MixedDrawing.selector);
        pool.join(3);
    }

    /// @dev The atomicity case that matters: valid ids are validated and written FIRST,
    ///      then a foreign id at a later index must roll all of it back. A partial commit
    ///      would leave `recordedTicket` set for ids the pool does not own.
    function test_foreignIdAfterValidIds_rollsBackCompletely() public {
        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.ForeignOwner);
        rtb.setForeignOwner(outsider);
        rtb.setForeignIndex(3); // three good ids get processed before the bad one

        uint256 balanceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert(IFarpotPool.InvalidTicketOwner.selector);
        pool.join(5);

        assertEq(pool.totalTickets(D0), 0, "no tickets recorded");
        assertEq(pool.ticketsByUser(D0, alice), 0, "no weight");
        assertEq(pool.contributorCount(D0), 0, "no contributor");
        assertEq(usdc.balanceOf(alice), balanceBefore, "joiner keeps their USDC");

        for (uint256 i; i < nft.allTokensLength(); ++i) {
            assertFalse(pool.recordedTicket(nft.tokenAt(i)), "no partial recordedTicket write");
        }
    }

    function test_mixedDrawingAfterValidIds_rollsBackCompletely() public {
        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.MixedDrawing);
        uint256 balanceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert(IFarpotPool.MixedDrawing.selector);
        pool.join(4);

        assertEq(pool.totalTickets(D0), 0, "no tickets recorded");
        assertEq(usdc.balanceOf(alice), balanceBefore, "joiner keeps their USDC");
        for (uint256 i; i < nft.allTokensLength(); ++i) {
            assertFalse(pool.recordedTicket(nft.tokenAt(i)), "no partial recordedTicket write");
        }
    }

    /// @dev §9: the pool must revert loudly on new joins if the upstream NFT is ever
    ///      replaced, not mis-account. Cannot be induced on a fork — `initialize()` is
    ///      one-shot and already consumed — so it is mock-only by necessity.
    function test_upstreamNftReplacement_revertsRatherThanMisAccounting() public {
        _join(alice, 1);

        MockTicketNFT replacement = new MockTicketNFT(address(jackpot));
        jackpot.setJackpotNFT(address(replacement));

        // The pool's `ticketNft` immutable still points at the ORIGINAL NFT, while the
        // Jackpot now mints through the replacement, so ownership/lookup must not agree.
        vm.prank(bob);
        vm.expectRevert();
        pool.join(1);

        assertEq(pool.totalTickets(D0), 1, "accounting untouched by the failed join");
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                                 CLAIM BATCH
//////////////////////////////////////////////////////////////////////////////*/

contract FarpotPoolClaimBatchTest is PoolTestBase {
    function test_claimBatch_zeroCount_reverts() public {
        _join(alice, 1);
        _rollover();
        vm.expectRevert(IFarpotPool.InvalidBatchSize.selector);
        pool.claimBatch(D0, 0);
    }

    function test_claimBatch_overMaxBatch_reverts() public {
        _join(alice, 1);
        _rollover();
        vm.expectRevert(IFarpotPool.InvalidBatchSize.selector);
        pool.claimBatch(D0, uint16(pool.MAX_CLAIM_BATCH()) + 1);
    }

    function test_claimBatch_currentDrawing_revertsNotSettled() public {
        _join(alice, 1);
        vm.expectRevert(IFarpotPool.NotSettled.selector);
        pool.claimBatch(D0, 1);
    }

    function test_claimBatch_futureDrawing_revertsNotSettled() public {
        _join(alice, 1);
        vm.expectRevert(IFarpotPool.NotSettled.selector);
        pool.claimBatch(D0 + 50, 1);
    }

    function test_claimBatch_settledButPoolNeverJoined_revertsNothingToClaim() public {
        _join(alice, 1);
        _rollover();
        // D0 - 1 is settled but the pool holds nothing in it.
        vm.expectRevert(IFarpotPool.NothingToClaim.selector);
        pool.claimBatch(D0 - 1, 1);
    }

    function test_claimBatch_drawingZero_revertsNothingToClaim() public {
        _join(alice, 1);
        _rollover();
        vm.expectRevert(IFarpotPool.NothingToClaim.selector);
        pool.claimBatch(0, 1);
    }

    function test_claimBatch_advancesCursorAndNeverRecoversASlice() public {
        _join(alice, _cap());
        _join(bob, 2); // 12 tickets total
        _rollover();

        pool.claimBatch(D0, 10);
        (,,,, uint256 cursor,) = pool.poolOf(D0);
        assertEq(cursor, 10, "cursor advanced");
        assertEq(_poolOwnedTickets(D0), 2, "ten burned, two left");

        // The remaining two are a smaller-than-requested final batch.
        pool.claimBatch(D0, 10);
        uint256 count;
        (,,,, cursor, count) = pool.poolOf(D0);
        assertEq(cursor, count, "cursor drained");
        assertEq(_poolOwnedTickets(D0), 0, "all burned");

        // A third call must not re-submit anything — re-submitting a burned ticket reverts.
        vm.expectRevert(IFarpotPool.NothingToClaim.selector);
        pool.claimBatch(D0, 10);
    }

    function test_claimBatch_exactFinalPartialBatch() public {
        _join(alice, 3);
        _rollover();
        pool.claimBatch(D0, 3);
        (,,,, uint256 cursor, uint256 count) = pool.poolOf(D0);
        assertEq(cursor, 3);
        assertEq(count, 3);
    }

    function test_claimBatch_isPermissionless() public {
        _join(alice, 1);
        _rollover();
        vm.prank(outsider);
        pool.claimBatch(D0, 1);
        (,,,, uint256 cursor,) = pool.poolOf(D0);
        assertEq(cursor, 1, "anyone may crank");
    }

    function test_claimBatch_toleratesLosersAndMixedBatches() public {
        _join(alice, 5);
        uint256 staked = _makeWinners(D0, 2, 4e6); // 2 winners, 3 losers
        _rollover();

        pool.claimBatch(D0, 5);
        assertEq(pool.pot(D0), staked, "losers neither poison nor contribute");
    }

    /// @dev The pot MUST be a measured delta: another drawing's unclaimed pot is sitting in
    ///      the contract at the same time, and a raw balance read would misattribute it.
    function test_pot_isAMeasuredDelta_whileAnotherDrawingsPotIsHeld() public {
        // Drawing D0: win 9 USDC, settle, collect, but nobody claims it.
        _join(alice, 2);
        uint256 firstPot = _makeWinners(D0, 2, 4_500_000);
        _rollover();
        pool.claimBatch(D0, 75);
        assertEq(pool.pot(D0), firstPot, "first pot");
        assertEq(usdc.balanceOf(address(pool)), firstPot, "held, unclaimed");

        // Drawing D0+1: win a different amount while the first pot is still in the contract.
        uint256 d1 = D0 + 1;
        _join(bob, 3);
        uint256 secondPot = _makeWinners(d1, 3, 1_000_000);
        _rollover();
        pool.claimBatch(d1, 75);

        assertEq(pool.pot(d1), secondPot, "second pot is the DELTA, not the balance");
        assertEq(pool.pot(D0), firstPot, "first pot untouched");
        assertEq(usdc.balanceOf(address(pool)), firstPot + secondPot, "both held");
    }

    function test_claimBatch_emitsBatchClaimed() public {
        _join(alice, 2);
        uint256 staked = _makeWinners(D0, 2, 3e6);
        _rollover();

        vm.expectEmit(true, true, true, true, address(pool));
        emit IFarpotPool.BatchClaimed(D0, 2, staked, 2);
        pool.claimBatch(D0, 75);
    }

    function test_claimBatch_worksWhilePaused() public {
        _join(alice, 1);
        _rollover();
        pool.pause();

        pool.claimBatch(D0, 1); // must not revert
        (,,,, uint256 cursor,) = pool.poolOf(D0);
        assertEq(cursor, 1, "claimBatch is never blocked by pause");
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                                    CLAIM
//////////////////////////////////////////////////////////////////////////////*/

contract FarpotPoolClaimTest is PoolTestBase {
    /// @notice Settle a drawing with a known pot and drained cursor.
    function _settleWithPot(uint256 d, uint256 winners, uint256 each) internal returns (uint256) {
        uint256 staked = _makeWinners(d, winners, each);
        _rollover();
        _drainCursor(d);
        return staked;
    }

    function test_claim_paysProRata() public {
        _join(alice, 3);
        _join(bob, 1); // 3:1 split
        uint256 potAmount = _settleWithPot(D0, 4, 1e6); // 4 USDC

        uint256 a0 = usdc.balanceOf(alice);
        uint256 b0 = usdc.balanceOf(bob);

        uint256[] memory ds = new uint256[](1);
        ds[0] = D0;
        vm.prank(alice);
        pool.claim(ds);
        vm.prank(bob);
        pool.claim(ds);

        assertEq(usdc.balanceOf(alice) - a0, potAmount * 3 / 4, "alice 3/4");
        assertEq(usdc.balanceOf(bob) - b0, potAmount * 1 / 4, "bob 1/4");
    }

    function test_claim_revertsWhileClaimable() public {
        _join(alice, 2);
        _makeWinners(D0, 2, 1e6);
        _rollover();
        pool.claimBatch(D0, 1); // partial: still Claimable

        uint256[] memory ds = new uint256[](1);
        ds[0] = D0;
        vm.prank(alice);
        vm.expectRevert(IFarpotPool.NotSettled.selector);
        pool.claim(ds);
    }

    function test_claim_succeedsTheMomentTheFinalBatchCompletes() public {
        _join(alice, 2);
        uint256 potAmount = _makeWinners(D0, 2, 1e6);
        _rollover();
        pool.claimBatch(D0, 1);
        pool.claimBatch(D0, 1); // now Settled, with no intervening write

        uint256[] memory ds = new uint256[](1);
        ds[0] = D0;
        uint256 a0 = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.claim(ds);
        assertEq(usdc.balanceOf(alice) - a0, potAmount, "sole contributor takes the pot");
    }

    function test_claim_duplicateDrawingIdsInOneCall_payOnce() public {
        _join(alice, 1);
        uint256 potAmount = _settleWithPot(D0, 1, 5e6);

        uint256[] memory ds = new uint256[](4);
        ds[0] = D0;
        ds[1] = D0;
        ds[2] = D0;
        ds[3] = D0;

        uint256 a0 = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.claim(ds);
        assertEq(usdc.balanceOf(alice) - a0, potAmount, "paid exactly once");
    }

    function test_claim_secondClaimIsANoOp() public {
        _join(alice, 1);
        _settleWithPot(D0, 1, 5e6);

        uint256[] memory ds = new uint256[](1);
        ds[0] = D0;
        vm.prank(alice);
        pool.claim(ds);

        uint256 a0 = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.claim(ds);
        assertEq(usdc.balanceOf(alice), a0, "no second payout");
    }

    function test_claim_zeroPot_isANoOpNotARevert() public {
        _join(alice, 2);
        _rollover();
        _drainCursor(D0); // all losers, pot stays 0

        uint256[] memory ds = new uint256[](1);
        ds[0] = D0;
        uint256 a0 = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.claim(ds); // must not revert
        assertEq(usdc.balanceOf(alice), a0, "nothing paid, nothing thrown");
    }

    function test_claim_nonContributor_isANoOp() public {
        _join(alice, 1);
        _settleWithPot(D0, 1, 5e6);

        uint256[] memory ds = new uint256[](1);
        ds[0] = D0;
        uint256 o0 = usdc.balanceOf(outsider);
        vm.prank(outsider);
        pool.claim(ds);
        assertEq(usdc.balanceOf(outsider), o0, "zero weight pays nothing");
    }

    function test_claim_emitsClaimed() public {
        _join(alice, 1);
        uint256 potAmount = _settleWithPot(D0, 1, 5e6);

        uint256[] memory ds = new uint256[](1);
        ds[0] = D0;
        vm.expectEmit(true, true, true, true, address(pool));
        emit IFarpotPool.Claimed(D0, alice, potAmount);
        vm.prank(alice);
        pool.claim(ds);
    }

    function test_claim_worksWhilePaused() public {
        _join(alice, 1);
        uint256 potAmount = _settleWithPot(D0, 1, 5e6);
        pool.pause();

        uint256[] memory ds = new uint256[](1);
        ds[0] = D0;
        uint256 a0 = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.claim(ds);
        assertEq(usdc.balanceOf(alice) - a0, potAmount, "claim is never blocked by pause");
    }

    /// @dev Floor division loses <1 unit PER CLAIMANT, so the aggregate bound is
    ///      `< contributorCount` — not the "sub-cent per drawing" an early draft claimed.
    function test_claim_dustBound_isBelowContributorCount() public {
        _join(alice, 1);
        _join(bob, 1);
        _join(carol, 1);
        uint256 potAmount = _settleWithPot(D0, 1, 10); // 10 atomic units over 3 tickets

        uint256[] memory ds = new uint256[](1);
        ds[0] = D0;
        uint256 paid;
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            uint256 b0 = usdc.balanceOf(who[i]);
            vm.prank(who[i]);
            pool.claim(ds);
            paid += usdc.balanceOf(who[i]) - b0;
        }

        assertEq(paid, 9, "3 x floor(10/3)");
        assertLe(paid, potAmount, "I5: never over-pays a drawing");
        assertLt(potAmount - paid, pool.contributorCount(D0), "dust < contributorCount");
    }

    /// @dev Every ordering must keep the per-drawing bound; none may let anyone claim twice.
    function test_claim_anyOrdering_neverExceedsPot() public {
        _join(alice, 2);
        _join(bob, 3);
        _join(carol, 5);
        uint256 potAmount = _settleWithPot(D0, 10, 333_333);

        uint256[] memory ds = new uint256[](1);
        ds[0] = D0;

        // A rotated order, each claiming once.
        address[3] memory order = [carol, alice, bob];
        uint256 paid;
        for (uint256 i; i < 3; ++i) {
            uint256 b0 = usdc.balanceOf(order[i]);
            vm.prank(order[i]);
            pool.claim(ds);
            paid += usdc.balanceOf(order[i]) - b0;
        }
        assertLe(paid, potAmount, "I5 holds under this ordering");

        // And nobody can come back for more.
        for (uint256 i; i < 3; ++i) {
            uint256 b0 = usdc.balanceOf(order[i]);
            vm.prank(order[i]);
            pool.claim(ds);
            assertEq(usdc.balanceOf(order[i]), b0, "no double claim");
        }
    }

    function test_claim_acrossTwoDrawingsInOneCall() public {
        _join(alice, 1);
        uint256 p0 = _settleWithPot(D0, 1, 2e6);

        uint256 d1 = D0 + 1;
        _join(alice, 1);
        uint256 p1 = _settleWithPot(d1, 1, 3e6);

        uint256[] memory ds = new uint256[](2);
        ds[0] = D0;
        ds[1] = d1;

        uint256 a0 = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.claim(ds);
        assertEq(usdc.balanceOf(alice) - a0, p0 + p1, "both drawings paid in one call");
    }

    /// @dev A huge array must only burn the caller's own gas — it cannot grief anyone else.
    function test_claim_veryLargeDrawingIdsArray_onlyCostsTheCaller() public {
        _join(alice, 1);
        uint256 potAmount = _settleWithPot(D0, 1, 5e6);

        uint256[] memory ds = new uint256[](500);
        for (uint256 i; i < 500; ++i) {
            ds[i] = D0;
        }

        uint256 a0 = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.claim(ds);
        assertEq(usdc.balanceOf(alice) - a0, potAmount, "still paid exactly once");
    }

    /// @dev Pro-rata must stay exact at a pot far beyond any real jackpot — no precision
    ///      loss, no truncation beyond the single floored unit.
    function test_claim_exactAtLargeMagnitudes() public {
        _join(alice, 3);
        _join(bob, 1);

        uint256 each = 1e24; // absurd on purpose
        usdc.mint(address(jackpot), 8 * each);
        uint256 potAmount = _makeWinners(D0, 4, each);
        _rollover();
        _drainCursor(D0);
        assertEq(pool.pot(D0), potAmount, "pot survives the magnitude");

        uint256[] memory ds = new uint256[](1);
        ds[0] = D0;
        uint256 a0 = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.claim(ds);
        assertEq(
            usdc.balanceOf(alice) - a0, FixedPointMathLib.fullMulDiv(potAmount, 3, 4), "exact floor share at scale"
        );
    }

    /// @dev Why the design mandates `fullMulDiv` rather than `pot * w / total`: the naive
    ///      form reverts on overflow whenever the intermediate product exceeds 2^256, which
    ///      would strand a pot permanently. `fullMulDiv` carries the full 512-bit product.
    ///      Not reachable with real USDC magnitudes, but the failure mode is unrecoverable,
    ///      so the property is pinned rather than argued.
    function test_fullMulDiv_survivesIntermediateProductAbove2Pow256() public {
        uint256 potAmount = type(uint256).max / 2;

        // The naive computation overflows and reverts.
        vm.expectRevert();
        this.naiveShare(potAmount, 4, 8);

        // The mandated one does not.
        assertEq(FixedPointMathLib.fullMulDiv(potAmount, 4, 8), potAmount / 2, "fullMulDiv holds");
    }

    function naiveShare(uint256 potAmount, uint256 w, uint256 total) external pure returns (uint256) {
        return potAmount * w / total;
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                          VIEWS: shareOf / poolOf
//////////////////////////////////////////////////////////////////////////////*/

contract FarpotPoolViewsTest is PoolTestBase {
    /// @dev The six-row table in design §4. `tickets` is ALWAYS the immutable historical
    ///      weight; only `owed` is state-dependent.
    function test_shareOf_neverParticipated() public view {
        (uint256 t, uint256 owed, bool has) = pool.shareOf(D0, outsider);
        assertEq(t, 0);
        assertEq(owed, 0);
        assertFalse(has);
    }

    function test_shareOf_joinedButNotSettled_owedIsZero() public {
        _join(alice, 3);
        (uint256 t, uint256 owed, bool has) = pool.shareOf(D0, alice);
        assertEq(t, 3, "weight visible immediately");
        assertEq(owed, 0, "no payout figure before settlement");
        assertFalse(has);
    }

    function test_shareOf_settledIncomplete_owedIsPartial() public {
        _join(alice, 2);
        _makeWinners(D0, 2, 5e6);
        _rollover();
        pool.claimBatch(D0, 1); // half collected

        (uint256 t, uint256 owed, bool has) = pool.shareOf(D0, alice);
        assertEq(t, 2);
        assertEq(owed, 5e6, "share of the pot collected SO FAR");
        assertFalse(has);
        assertEq(uint8(pool.poolStateOf(D0)), uint8(IFarpotPool.PoolState.Claimable), "UI must hide this figure");
    }

    function test_shareOf_settledNotYetClaimed_owedIsFinal() public {
        _join(alice, 2);
        uint256 potAmount = _makeWinners(D0, 2, 5e6);
        _rollover();
        _drainCursor(D0);

        (uint256 t, uint256 owed, bool has) = pool.shareOf(D0, alice);
        assertEq(t, 2);
        assertEq(owed, potAmount);
        assertFalse(has);
    }

    function test_shareOf_afterClaiming_retainsWeight() public {
        _join(alice, 2);
        _makeWinners(D0, 2, 5e6);
        _rollover();
        _drainCursor(D0);

        uint256[] memory ds = new uint256[](1);
        ds[0] = D0;
        vm.prank(alice);
        pool.claim(ds);

        (uint256 t, uint256 owed, bool has) = pool.shareOf(D0, alice);
        assertEq(t, 2, "historical participation stays readable after claiming");
        assertEq(owed, 0);
        assertTrue(has);
    }

    function test_shareOf_settledButWonNothing() public {
        _join(alice, 2);
        _rollover();
        _drainCursor(D0);

        (uint256 t, uint256 owed, bool has) = pool.shareOf(D0, alice);
        assertEq(t, 2);
        assertEq(owed, 0, "no division performed");
        assertFalse(has);
    }

    /// @dev Must not divide by zero for a drawing nobody joined.
    function test_shareOf_zeroTotalTickets_doesNotRevert() public view {
        (uint256 t, uint256 owed,) = pool.shareOf(D0 + 99, alice);
        assertEq(t, 0);
        assertEq(owed, 0);
    }

    function test_poolOf_reportsEveryField() public {
        _join(alice, 2);
        _join(bob, 1);

        (
            uint256 tickets,
            uint256 contributors,
            uint256 potAmount,
            IFarpotPool.PoolState state,
            uint256 cursor,
            uint256 ticketCount
        ) = pool.poolOf(D0);

        assertEq(tickets, 3);
        assertEq(contributors, 2);
        assertEq(potAmount, 0);
        assertEq(uint8(state), uint8(IFarpotPool.PoolState.Accumulating));
        assertEq(cursor, 0);
        assertEq(ticketCount, 3);
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                        DERIVED LIFECYCLE (poolStateOf)
//////////////////////////////////////////////////////////////////////////////*/

contract FarpotPoolStateTest is PoolTestBase {
    function test_poolState_numericValuesAreStable() public pure {
        assertEq(uint8(IFarpotPool.PoolState.None), 0, "None");
        assertEq(uint8(IFarpotPool.PoolState.Accumulating), 1, "Accumulating");
        assertEq(uint8(IFarpotPool.PoolState.Claimable), 2, "Claimable");
        assertEq(uint8(IFarpotPool.PoolState.Settled), 3, "Settled");
    }

    function test_poolState_futureDrawing_isNone() public view {
        assertEq(uint8(pool.poolStateOf(D0 + 5)), uint8(IFarpotPool.PoolState.None));
    }

    function test_poolState_pastDrawingNeverJoined_isNoneNotSettled() public {
        _rollover();
        assertEq(
            uint8(pool.poolStateOf(D0 - 1)),
            uint8(IFarpotPool.PoolState.None),
            "an untouched drawing must never present as Settled"
        );
    }

    /// @dev The v5 ordering returned `None` here, forcing the frontend to combine two fields
    ///      to answer "can I join?".
    function test_poolState_currentDrawingWhileEmpty_isAccumulating() public view {
        assertEq(uint8(pool.poolStateOf(D0)), uint8(IFarpotPool.PoolState.Accumulating));
    }

    /// @dev The full sequence in one test, which is how the plan specifies it.
    function test_poolState_fullTransitionSequence() public {
        assertEq(uint8(pool.poolStateOf(D0)), uint8(IFarpotPool.PoolState.Accumulating), "empty current");

        _join(alice, 3);
        assertEq(uint8(pool.poolStateOf(D0)), uint8(IFarpotPool.PoolState.Accumulating), "after join");

        _rollover();
        assertEq(uint8(pool.poolStateOf(D0)), uint8(IFarpotPool.PoolState.Claimable), "after rollover");

        pool.claimBatch(D0, 1);
        assertEq(uint8(pool.poolStateOf(D0)), uint8(IFarpotPool.PoolState.Claimable), "partial batch");

        pool.claimBatch(D0, 2);
        assertEq(uint8(pool.poolStateOf(D0)), uint8(IFarpotPool.PoolState.Settled), "final batch");

        uint256[] memory ds = new uint256[](1);
        ds[0] = D0;
        vm.prank(alice);
        pool.claim(ds);
        assertEq(uint8(pool.poolStateOf(D0)), uint8(IFarpotPool.PoolState.Settled), "unchanged by claiming");
    }

    /// @dev The exact case a stored lifecycle got wrong: the drawing rolls over with NO pool
    ///      transaction, so nothing could have written a new state.
    function test_poolState_doesNotGoStaleWithoutAPoolTransaction() public {
        _join(alice, 1);
        assertEq(uint8(pool.poolStateOf(D0)), uint8(IFarpotPool.PoolState.Accumulating));

        _rollover(); // no pool call whatsoever

        assertEq(
            uint8(pool.poolStateOf(D0)),
            uint8(IFarpotPool.PoolState.Claimable),
            "derived state must track currentDrawingId with no write"
        );
    }

    /// @dev The pseudocode caches `currentDrawingId` in `cur`; a second read would be both
    ///      wasteful and a torn-read hazard.
    function test_poolState_readsCurrentDrawingIdExactlyOnce() public {
        _join(alice, 1);
        vm.expectCall(address(jackpot), abi.encodeWithSelector(IJackpot.currentDrawingId.selector), 1);
        pool.poolStateOf(D0);
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                        ACCESS CONTROL & PAUSE
//////////////////////////////////////////////////////////////////////////////*/

contract FarpotPoolAccessTest is PoolTestBase {
    function test_pause_blocksJoin() public {
        pool.pause();
        vm.prank(alice);
        vm.expectRevert();
        pool.join(1);
    }

    function test_unpause_restoresJoin() public {
        pool.pause();
        pool.unpause();
        _join(alice, 1);
        assertEq(pool.totalTickets(D0), 1);
    }

    function test_pause_onlyOwner() public {
        vm.prank(outsider);
        vm.expectRevert(Ownable.Unauthorized.selector);
        pool.pause();
    }

    function test_unpause_onlyOwner() public {
        pool.pause();
        vm.prank(outsider);
        vm.expectRevert(Ownable.Unauthorized.selector);
        pool.unpause();
    }

    function test_pause_emitsPausedSet() public {
        vm.expectEmit(true, true, true, true, address(pool));
        emit IFarpotPool.PausedSet(true);
        pool.pause();
    }

    /// @dev The whole owner model: pause is the ONLY power, and it cannot touch funds.
    ///      Enumerated against the live ABI so a future function that grants the owner
    ///      reach over money fails this test rather than slipping in unnoticed.
    function test_owner_hasNoFunctionThatCanTouchFunds() public {
        _join(alice, 5);
        _makeWinners(D0, 5, 1e6);
        _rollover();
        _drainCursor(D0);

        uint256 held = usdc.balanceOf(address(pool));
        assertGt(held, 0, "fixture: the pool must be holding money");

        address owner = pool.owner();
        uint256 ownerBefore = usdc.balanceOf(owner);

        // There is no sweep / rescue / withdraw / skip. Probe for them by selector: any hit
        // that does not revert would be a path from owner to funds.
        string[6] memory sigs = [
            "sweep(address,uint256)",
            "rescue(address,uint256)",
            "withdraw(uint256)",
            "emergencyWithdraw()",
            "skip(uint256,uint256)",
            "setPot(uint256,uint256)"
        ];
        for (uint256 i; i < sigs.length; ++i) {
            (bool ok,) = address(pool).call(abi.encodeWithSignature(sigs[i]));
            assertFalse(ok, string.concat("owner escape hatch exists: ", sigs[i]));
        }

        assertEq(usdc.balanceOf(address(pool)), held, "pool balance untouched");
        assertEq(usdc.balanceOf(owner), ownerBefore, "owner gained nothing");
    }

    function test_owner_cannotWriteContributorState() public {
        _join(alice, 2);
        // No setter exists for any of these; assert the values are exactly what join wrote.
        assertEq(pool.ticketsByUser(D0, alice), 2);
        assertFalse(pool.claimed(D0, alice));
        assertEq(pool.pot(D0), 0);
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                                CONSTRUCTOR
//////////////////////////////////////////////////////////////////////////////*/

contract FarpotPoolConstructorTest is PoolTestBase {
    function _deploy(address j, address r, address n, address u, address ref) internal returns (FarpotPool) {
        return new FarpotPool(j, r, n, u, ref);
    }

    function test_constructor_happyPath_setsImmutables() public view {
        assertEq(address(pool.jackpot()), address(jackpot));
        assertEq(address(pool.randomTicketBuyer()), address(rtb));
        assertEq(address(pool.ticketNft()), address(nft));
        assertEq(pool.usdc(), address(usdc));
        assertEq(pool.referralWallet(), REFERRAL);
    }

    function test_constructor_rejectsZeroJackpot() public {
        vm.expectRevert(IFarpotPool.ZeroAddress.selector);
        _deploy(address(0), address(rtb), address(nft), address(usdc), REFERRAL);
    }

    function test_constructor_rejectsZeroBuyer() public {
        vm.expectRevert(IFarpotPool.ZeroAddress.selector);
        _deploy(address(jackpot), address(0), address(nft), address(usdc), REFERRAL);
    }

    function test_constructor_rejectsZeroNft() public {
        vm.expectRevert(IFarpotPool.ZeroAddress.selector);
        _deploy(address(jackpot), address(rtb), address(0), address(usdc), REFERRAL);
    }

    function test_constructor_rejectsZeroUsdc() public {
        vm.expectRevert(IFarpotPool.ZeroAddress.selector);
        _deploy(address(jackpot), address(rtb), address(nft), address(0), REFERRAL);
    }

    function test_constructor_rejectsZeroReferralWallet() public {
        vm.expectRevert(IFarpotPool.ZeroAddress.selector);
        _deploy(address(jackpot), address(rtb), address(nft), address(usdc), address(0));
    }

    /// @dev A self-referential referral wallet would silently recycle fees back into the
    ///      contract, where nothing can ever spend them.
    function test_constructor_rejectsSelfAsReferralWallet() public {
        // The address the next CREATE from this test contract will land on.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(IFarpotPool.InvalidReferralWallet.selector);
        _deploy(address(jackpot), address(rtb), address(nft), address(usdc), predicted);
    }

    function test_constructor_rejectsEoaForEachDependency() public {
        address eoa = makeAddr("eoa");

        vm.expectRevert(IFarpotPool.NotAContract.selector);
        _deploy(eoa, address(rtb), address(nft), address(usdc), REFERRAL);

        vm.expectRevert(IFarpotPool.NotAContract.selector);
        _deploy(address(jackpot), eoa, address(nft), address(usdc), REFERRAL);

        vm.expectRevert(IFarpotPool.NotAContract.selector);
        _deploy(address(jackpot), address(rtb), eoa, address(usdc), REFERRAL);

        vm.expectRevert(IFarpotPool.NotAContract.selector);
        _deploy(address(jackpot), address(rtb), address(nft), eoa, REFERRAL);
    }

    /// @dev The referral wallet is the one address allowed to be an EOA.
    function test_constructor_allowsEoaReferralWallet() public {
        FarpotPool p = _deploy(address(jackpot), address(rtb), address(nft), address(usdc), makeAddr("eoa"));
        assertEq(p.referralWallet(), makeAddr("eoa"));
    }

    /*//////////////////////////////////////////////////////////////
              THE FIVE GETTER CROSS-CHECKS THAT PIN THE GRAPH
    //////////////////////////////////////////////////////////////*/

    function test_constructor_rejectsWrongJackpotNft() public {
        MockTicketNFT other = new MockTicketNFT(address(jackpot));
        jackpot.setJackpotNFT(address(other)); // jackpot.jackpotNFT() != _nft
        vm.expectRevert(IFarpotPool.InconsistentDeps.selector);
        _deploy(address(jackpot), address(rtb), address(nft), address(usdc), REFERRAL);
    }

    function test_constructor_rejectsWrongJackpotUsdc() public {
        MockUSDC other = new MockUSDC();
        jackpot.setUsdc(address(other)); // jackpot.usdc() != _usdc
        vm.expectRevert(IFarpotPool.InconsistentDeps.selector);
        _deploy(address(jackpot), address(rtb), address(nft), address(usdc), REFERRAL);
    }

    function test_constructor_rejectsWrongBuyerJackpot() public {
        MockJackpot other = new MockJackpot(address(nft), address(usdc), D0);
        rtb.setJackpot(address(other)); // rtb.jackpot() != _jackpot
        vm.expectRevert(IFarpotPool.InconsistentDeps.selector);
        _deploy(address(jackpot), address(rtb), address(nft), address(usdc), REFERRAL);
    }

    function test_constructor_rejectsWrongBuyerUsdc() public {
        MockUSDC other = new MockUSDC();
        rtb.setUsdc(address(other)); // rtb.usdc() != _usdc
        vm.expectRevert(IFarpotPool.InconsistentDeps.selector);
        _deploy(address(jackpot), address(rtb), address(nft), address(usdc), REFERRAL);
    }

    function test_constructor_rejectsWrongNftJackpot() public {
        MockJackpot other = new MockJackpot(address(nft), address(usdc), D0);
        nft.setJackpot(address(other)); // nft.jackpot() != _jackpot
        vm.expectRevert(IFarpotPool.InconsistentDeps.selector);
        _deploy(address(jackpot), address(rtb), address(nft), address(usdc), REFERRAL);
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                                 STRAY NFTs
//////////////////////////////////////////////////////////////////////////////*/

contract FarpotPoolStrayNftTest is PoolTestBase {
    /// @dev The pool implements no receiver hook, deliberately — so a safe transfer in
    ///      cannot land at all.
    function test_safeTransferFromIntoPool_reverts() public {
        jackpot.setAuthorizedMinter(address(this), true);
        uint256 id = jackpot.mintFor(address(this), D0);

        vm.expectRevert(MockTicketNFT.TransferToNonERC721ReceiverImplementer.selector);
        nft.safeTransferFrom(address(this), address(pool), id);
    }

    /// @dev A plain transfer cannot be prevented. The token is stranded — invisible to
    ///      `ticketIds`, unclaimable, and by design not rescuable — but no accounting moves
    ///      and no contributor funds are at risk.
    function test_plainTransferIntoPool_strandsTokenWithoutCorruptingAccounting() public {
        _join(alice, 2);
        (,,,,, uint256 countBefore) = pool.poolOf(D0);

        jackpot.setAuthorizedMinter(address(this), true);
        uint256 id = jackpot.mintFor(address(this), D0);
        nft.transferFrom(address(this), address(pool), id);

        assertEq(nft.ownerOf(id), address(pool), "stranded in the pool");
        assertFalse(pool.recordedTicket(id), "never recorded");

        (,,,,, uint256 countAfter) = pool.poolOf(D0);
        assertEq(countAfter, countBefore, "ticketIds unchanged");
        assertEq(pool.totalTickets(D0), 2, "totals unchanged");
        assertEq(pool.contributorCount(D0), 1, "contributors unchanged");
    }
}

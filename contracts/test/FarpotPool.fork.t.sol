// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {Vm} from "forge-std/Vm.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";

import {FarpotPool} from "../src/FarpotPool.sol";
import {MegapotAddresses} from "../src/MegapotAddresses.sol";
import {IFarpotPool} from "../src/interfaces/IFarpotPool.sol";
import {IJackpot} from "../src/interfaces/IJackpot.sol";
import {IJackpotTicketNFT} from "../src/interfaces/IJackpotTicketNFT.sol";

interface IERC20Fork {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Fork tests against the REAL Megapot contracts on Base mainnet.
/// @dev The mocks cannot prove Megapot's actual behaviour; this is where the design's source
///      reading becomes execution. Everything here runs against live deployed bytecode.
///
///      Blocks are pinned deliberately, each chosen by binary-searching live chain state
///      rather than picked at random:
///        - `BLOCK_OPEN`    drawing 129 open and UNLOCKED — the normal buying path.
///        - `BLOCK_LOCKED`  drawing 129 still current but `jackpotLock` already true — the
///                          near-draw boundary, which is otherwise unreachable in a test.
///        - `BLOCK_SETTLED` the FIRST block at drawing 130, i.e. the block in which 129
///                          settled. Settlement and rollover are atomic, so this is the
///                          earliest possible moment a claim for 129 can be valid.
contract FarpotPoolForkTest is Test {
    // Sourced from ONE Solidity constant set, which `npm run check:addresses` pins against
    // src/lib/constants.ts. Copying them per-file lets the test and a drifted address quietly
    // agree with each other while the app disagrees with both.
    address internal constant JACKPOT = MegapotAddresses.JACKPOT;
    address internal constant RTB = MegapotAddresses.RANDOM_TICKET_BUYER;
    address internal constant NFT = MegapotAddresses.TICKET_NFT;
    address internal constant USDC = MegapotAddresses.USDC;
    address internal constant REFERRAL = MegapotAddresses.REFERRAL_WALLET;

    uint256 internal constant BLOCK_OPEN = 49_363_800;
    uint256 internal constant BLOCK_LOCKED = 49_363_931;
    uint256 internal constant BLOCK_SETTLED = 49_363_932;
    uint256 internal constant DRAWING_OPEN = 129;

    /// @dev The stage-1 ship gate from design §4.1.
    uint256 internal constant GAS_GATE = 12_000_000;

    FarpotPool internal pool;
    address internal alice;

    function _forkAt(uint256 blockNumber) internal {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"), blockNumber);
        alice = makeAddr("alice");
        pool = new FarpotPool(JACKPOT, RTB, NFT, USDC, REFERRAL);
        deal(USDC, alice, 10_000e6);
        vm.prank(alice);
        IERC20Fork(USDC).approve(address(pool), type(uint256).max);
    }

    /// @notice Ticket ids minted to the pool during the last recorded block of logs.
    /// @dev Read from the NFT's own `Transfer(0x0 -> pool)` events rather than from pool
    ///      storage, so this asserts what the CHAIN saw, not what our contract believes.
    function _mintedIds() internal view returns (uint256[] memory ids) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 transferSig = keccak256("Transfer(address,address,uint256)");
        uint256 n;
        uint256[] memory buf = new uint256[](logs.length);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != NFT) continue;
            if (logs[i].topics.length != 4) continue;
            if (logs[i].topics[0] != transferSig) continue;
            if (uint256(logs[i].topics[1]) != 0) continue; // mint only
            if (address(uint160(uint256(logs[i].topics[2]))) != address(pool)) continue;
            buf[n++] = uint256(logs[i].topics[3]);
        }
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = buf[i];
        }
    }

    /*//////////////////////////////////////////////////////////////
                        CONSTRUCTOR AGAINST REALITY
    //////////////////////////////////////////////////////////////*/

    /// @dev The five cross-checks running against live bytecode. This is the only thing that
    ///      proves the addresses in `constants.ts` are mutually consistent on-chain — a mock
    ///      graph is wired by the test, so it can only ever agree with itself.
    function test_fork_constructorAcceptsTheRealDependencyGraph() public {
        _forkAt(BLOCK_OPEN);
        assertEq(address(pool.jackpot()), JACKPOT);
        assertEq(address(pool.randomTicketBuyer()), RTB);
        assertEq(address(pool.ticketNft()), NFT);
        assertEq(pool.usdc(), USDC);
        assertEq(pool.referralWallet(), REFERRAL);
        assertEq(pool.jackpot().currentDrawingId(), DRAWING_OPEN, "pinned block sanity");
    }

    /*//////////////////////////////////////////////////////////////
                              REAL JOIN
    //////////////////////////////////////////////////////////////*/

    function test_fork_realJoin_recordsRealTickets() public {
        _forkAt(BLOCK_OPEN);

        vm.recordLogs();
        vm.prank(alice);
        pool.join(3);
        uint256[] memory ids = _mintedIds();

        assertEq(ids.length, 3, "three tickets minted to the pool on-chain");

        (uint256 tickets,,,,, uint256 ticketCount) = pool.poolOf(DRAWING_OPEN);
        assertEq(tickets, 3, "accounting");
        assertEq(ticketCount, 3, "ticket list");
        assertEq(pool.ticketsByUser(DRAWING_OPEN, alice), 3, "weight");
        assertEq(pool.contributorCount(DRAWING_OPEN), 1, "contributor");

        for (uint256 i; i < ids.length; ++i) {
            assertEq(IJackpotTicketNFT(NFT).ownerOf(ids[i]), address(pool), "pool owns it");
            // The derived drawing must equal what the REAL NFT reports.
            assertEq(
                IJackpotTicketNFT(NFT).getTicketInfo(ids[i]).drawingId,
                DRAWING_OPEN,
                "derived drawing matches the ticket's own binding"
            );
            assertTrue(pool.recordedTicket(ids[i]), "recorded");
        }
    }

    function test_fork_realJoin_leavesNoAllowanceAndNoIdleUsdc() public {
        _forkAt(BLOCK_OPEN);
        vm.prank(alice);
        pool.join(2);
        assertEq(IERC20Fork(USDC).balanceOf(address(pool)), 0, "no idle contribution held");
    }

    /// @dev The near-draw boundary. Unreachable without pinning a block where the real
    ///      contract has already locked.
    function test_fork_joinWhileJackpotLocked_revertsPoolLocked() public {
        _forkAt(BLOCK_LOCKED);
        assertTrue(pool.jackpot().getDrawingState(DRAWING_OPEN).jackpotLock, "pinned block must be locked");
        vm.prank(alice);
        vm.expectRevert(IFarpotPool.PoolLocked.selector);
        pool.join(1);
    }

    /*//////////////////////////////////////////////////////////////
                     SETTLEMENT TIMING (design §2.2)
    //////////////////////////////////////////////////////////////*/

    /// @dev Empirical half of the atomicity claim. At the last block of drawing 129 a claim
    ///      for 129 must be refused; the very next block — the one in which 129 settled and
    ///      `currentDrawingId` became 130 — it must be accepted. There is no window between.
    function test_fork_claimBatch_refusedWhileDrawingIsCurrent() public {
        _forkAt(BLOCK_LOCKED);
        assertEq(pool.jackpot().currentDrawingId(), DRAWING_OPEN, "still current");
        vm.expectRevert(IFarpotPool.NotSettled.selector);
        pool.claimBatch(DRAWING_OPEN, 1);
    }

    function test_fork_claimBatch_acceptedTheInstantTheDrawingSettles() public {
        _forkAt(BLOCK_SETTLED);
        assertEq(pool.jackpot().currentDrawingId(), DRAWING_OPEN + 1, "rolled over in this block");

        // The settled gate now passes, so the batch-size guard is what answers instead of
        // `NotSettled` — proving `d < currentDrawingId` is already satisfied at this block.
        vm.expectRevert(IFarpotPool.InvalidBatchSize.selector);
        pool.claimBatch(DRAWING_OPEN, 0);

        // And with a valid size it is the empty-cursor guard that answers, not the gate:
        // this fresh pool simply holds no tickets in 129.
        vm.expectRevert(IFarpotPool.NothingToClaim.selector);
        pool.claimBatch(DRAWING_OPEN, 1);
    }

    function test_fork_claimBatch_rejectsFutureDrawing() public {
        _forkAt(BLOCK_OPEN);
        vm.expectRevert(IFarpotPool.NotSettled.selector);
        pool.claimBatch(DRAWING_OPEN + 5, 1);
    }

    /*//////////////////////////////////////////////////////////////
          A REAL POOL, BOUGHT BEFORE THE DRAW AND CLAIMED AFTER

      The hard one. A pool deployed on a fork cannot own tickets from a
      drawing that settled before it existed, and a drawing bought into
      cannot be settled by us — `scaledEntropyCallback` is `onlyEntropy`.

      Resolved by buying at `BLOCK_OPEN`, marking the POOL and the TICKET
      NFT persistent, then rolling the fork to `BLOCK_SETTLED`. The Jackpot
      is deliberately NOT persistent, so it re-reads real chain state: the
      genuine winning ticket for 129 and the genuine tier payouts. Our
      tickets carry real `packedTicket` values from a real buy, so the tier
      each one lands in is computed by Megapot from real numbers — nothing
      about the payout is fabricated.
    //////////////////////////////////////////////////////////////*/

    /// @notice Buys `n` tickets in capped joins, returns the minted ids.
    function _buyTickets(uint256 n) internal returns (uint256[] memory ids) {
        vm.recordLogs();
        uint256 cap = pool.MAX_TICKETS_PER_JOIN();
        uint256 bought;
        while (bought < n) {
            uint32 batch = uint32(n - bought < cap ? n - bought : cap);
            vm.prank(alice);
            pool.join(batch);
            bought += batch;
        }
        ids = _mintedIds();
    }

    /// @notice Correctness AND the full claim-gas profile, on a real settled drawing.
    /// @dev Buys `MAX_CLAIM_BATCH` tickets so every required case is MEASURED rather than
    ///      extrapolated from a smaller batch:
    ///        - the full 75-ticket batch (the operative ceiling for the cron);
    ///        - a pure-LOSER batch, isolated from the longest run of consecutive losers;
    ///        - a pure-WINNER batch, from the longest run of consecutive winners;
    ///        - per-ticket cost of a winner vs a loser, which is what answers "does a
    ///          winner-heavy batch cost materially more".
    ///      Runs are used because `claimBatch` walks the cursor in order: the only way to get
    ///      a homogeneous batch out of real Megapot outcomes, which we cannot choose, is to
    ///      advance the cursor to a run and claim exactly that run.
    function test_fork_claimBatch_overARealSettledDrawingWithFullGasProfile() public {
        _forkAt(BLOCK_OPEN);

        uint256 n = pool.MAX_CLAIM_BATCH(); // 75
        uint256[] memory ids = _buyTickets(n);
        assertEq(ids.length, n, "bought a full claim batch while 129 was open");

        // Carry the pool and the tickets across the roll; let everything else re-read.
        vm.makePersistent(address(pool));
        vm.makePersistent(NFT);
        vm.rollFork(BLOCK_SETTLED);

        assertEq(pool.jackpot().currentDrawingId(), DRAWING_OPEN + 1, "129 settled in this block");
        assertTrue(
            pool.jackpot().getDrawingState(DRAWING_OPEN).winningTicket != bytes32(0), "real winning ticket is stored"
        );

        // ---- classify every ticket, one claim at a time -------------------------------
        bool[] memory won = _classify(n);
        uint256 winners = _countTrue(won);
        uint256 losers = n - winners;

        // The batch must be genuinely MIXED. `pot > 0` alone only proves a winner exists;
        // this proves a loser was in there too and did not poison the batch.
        assertGt(winners, 0, "batch must contain at least one winner");
        assertGt(losers, 0, "batch must contain at least one loser");
        console.log("tickets", n, "winners", winners);
        console.log("losers ", losers);

        // ---- the full-size batch: the number the cron actually depends on --------------
        _measureFullBatch(n);

        // ---- homogeneous runs: a pure-loser batch and a pure-winner batch --------------
        (uint256 loseStart, uint256 loseLen) = _longestRun(won, false);
        (uint256 winStart, uint256 winLen) = _longestRun(won, true);
        assertGt(loseLen, 0, "need at least one loser run");
        assertGt(winLen, 0, "need at least one winner run");

        uint256 gasLosersOnly = _measureRun(loseStart, loseLen);
        uint256 gasWinnersOnly = _measureRun(winStart, winLen);

        console.log("pure-LOSER  batch size", loseLen, "gas", gasLosersOnly);
        console.log("  per ticket", gasLosersOnly / loseLen);
        console.log("pure-WINNER batch size", winLen, "gas", gasWinnersOnly);
        console.log("  per ticket", gasWinnersOnly / winLen);
        // Multiply first: dividing to a per-ticket figure and scaling back up loses precision.
        uint256 allWinner75 = gasWinnersOnly * 75 / winLen;
        console.log("projected all-winner 75 batch", allWinner75);

        // The binding operational claim: even priced at the measured PURE-WINNER per-ticket
        // cost, a full 75 batch stays far inside a block. This is what makes 75 safe rather
        // than an extrapolation from a mostly-losing sample.
        assertLt(allWinner75, GAS_GATE, "all-winner 75 batch fits under the gate");
    }

    /// @notice Claim each ticket alone to learn which won, then restore. Also reports the
    ///         per-ticket cost of each class, which is what a winner-heavy batch turns on.
    function _classify(uint256 n) internal returns (bool[] memory won) {
        uint256 snap = vm.snapshotState();
        won = new bool[](n);
        uint256 winnerGas;
        uint256 loserGas;
        uint256 winners;
        for (uint256 i; i < n; ++i) {
            uint256 balBefore = IERC20Fork(USDC).balanceOf(address(pool));
            uint256 g0 = gasleft();
            pool.claimBatch(DRAWING_OPEN, 1);
            uint256 g = g0 - gasleft();
            if (IERC20Fork(USDC).balanceOf(address(pool)) > balBefore) {
                won[i] = true;
                ++winners;
                winnerGas += g;
            } else {
                loserGas += g;
            }
        }
        if (winners > 0) console.log("gas per single-ticket claim, winner", winnerGas / winners);
        if (n - winners > 0) console.log("gas per single-ticket claim, loser ", loserGas / (n - winners));
        vm.revertToState(snap);
    }

    function _countTrue(bool[] memory flags) internal pure returns (uint256 n) {
        for (uint256 i; i < flags.length; ++i) {
            if (flags[i]) ++n;
        }
    }

    /// @notice The full MAX_CLAIM_BATCH claim: correctness plus the operative gas ceiling.
    function _measureFullBatch(uint256 n) internal {
        uint256 snap = vm.snapshotState();
        uint256 balStart = IERC20Fork(USDC).balanceOf(address(pool));
        uint256 g0 = gasleft();
        pool.claimBatch(DRAWING_OPEN, SafeCastLib.toUint16(n));
        uint256 gasFull = g0 - gasleft();

        (,, uint256 potAmount,, uint256 cursor, uint256 ticketCount) = pool.poolOf(DRAWING_OPEN);
        console.log("gas claimBatch(75), mixed", gasFull);
        console.log("pot collected (USDC 1e6) ", potAmount);

        assertEq(cursor, ticketCount, "cursor drained in one batch");
        assertEq(uint8(pool.poolStateOf(DRAWING_OPEN)), uint8(IFarpotPool.PoolState.Settled), "Settled");
        assertGt(potAmount, 0, "a 75-ticket batch must collect real winnings");
        assertEq(IERC20Fork(USDC).balanceOf(address(pool)) - balStart, potAmount, "pot is the measured delta");
        // Every ticket is burned whether it won or not, so a re-submission is refused.
        vm.expectRevert(IFarpotPool.NothingToClaim.selector);
        pool.claimBatch(DRAWING_OPEN, SafeCastLib.toUint16(n));
        vm.revertToState(snap);
    }

    /// @notice Longest run of consecutive `target` entries. Returns (start, length).
    function _longestRun(bool[] memory flags, bool target) internal pure returns (uint256 bestStart, uint256 bestLen) {
        uint256 curStart;
        uint256 curLen;
        for (uint256 i; i < flags.length; ++i) {
            if (flags[i] == target) {
                if (curLen == 0) curStart = i;
                ++curLen;
                if (curLen > bestLen) {
                    bestLen = curLen;
                    bestStart = curStart;
                }
            } else {
                curLen = 0;
            }
        }
    }

    /// @notice Gas for claiming exactly `len` tickets starting at cursor position `start`.
    /// @dev Advances the cursor to `start` in a separate, unmeasured call first, so the
    ///      measurement covers only the homogeneous run.
    function _measureRun(uint256 start, uint256 len) internal returns (uint256 used) {
        uint256 snap = vm.snapshotState();
        if (start > 0) pool.claimBatch(DRAWING_OPEN, SafeCastLib.toUint16(start));
        uint256 g0 = gasleft();
        pool.claimBatch(DRAWING_OPEN, SafeCastLib.toUint16(len));
        used = g0 - gasleft();
        vm.revertToState(snap);
    }

    /*//////////////////////////////////////////////////////////////
                     GAS — THE STAGE-1 SHIP GATE (§4.1)
    //////////////////////////////////////////////////////////////*/

    function _measureJoin(uint32 n) internal returns (uint256 used) {
        _forkAt(BLOCK_OPEN);
        vm.prank(alice);
        uint256 before = gasleft();
        pool.join(n);
        used = before - gasleft();
    }

    function test_fork_gas_join_measuredAndUnderTheGate() public {
        uint256 g1 = _measureJoin(1);
        uint256 g5 = _measureJoin(5);
        uint256 g10 = _measureJoin(10);

        console.log("gas join(1) ", g1);
        console.log("gas join(5) ", g5);
        console.log("gas join(10)", g10);
        console.log("marginal per ticket 1->10", (g10 - g1) / 9);

        // Design §4.1 stage-1 pass condition. Projected ~8.58M against a 12M gate.
        assertLt(g10, GAS_GATE, "join(MAX_TICKETS_PER_JOIN) must fit under the 12M gate");
        assertLt(g1, g5, "cost grows with tickets");
        assertLt(g5, g10, "cost grows with tickets");
    }
}

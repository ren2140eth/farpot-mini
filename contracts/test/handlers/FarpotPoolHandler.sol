// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {FarpotPool} from "../../src/FarpotPool.sol";
import {IFarpotPool} from "../../src/interfaces/IFarpotPool.sol";
import {MockJackpot} from "../mocks/MockJackpot.sol";
import {MockRandomTicketBuyer} from "../mocks/MockRandomTicketBuyer.sol";
import {MockTicketNFT} from "../mocks/MockTicketNFT.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @notice Bounded actor for the invariant fuzzer.
/// @dev Two disciplines make this harness trustworthy, both required by the plan:
///
///      1. **Every input is bounded.** Ticket counts, batch sizes, actors and drawings are
///         all `bound()`ed into legal ranges, so an expected-invalid call is deliberate
///         rather than incidental.
///      2. **Every function pre-checks and returns early instead of reverting.** A harness
///         running under `fail_on_revert = false` can silently spend all its calls bouncing
///         off guards while never reaching `claim`, and the invariants would then hold
///         vacuously over an empty state space. Guarding here lets CI run with
///         `fail_on_revert = true`, and the per-function success counters below turn a
///         coverage collapse into a loud failure rather than a quiet green tick.
contract FarpotPoolHandler is CommonBase, StdCheats, StdUtils {
    FarpotPool public immutable pool;
    MockJackpot public immutable jackpot;
    MockTicketNFT public immutable nft;
    MockRandomTicketBuyer public immutable rtb;
    MockUSDC public immutable usdc;

    address[] public actors;

    /// @dev Every drawing the pool has ever held a ticket in.
    uint256[] public touchedDrawings;
    mapping(uint256 => bool) internal _seen;

    /*//////////////////////////////////////////////////////////////
                               GHOST STATE
    //////////////////////////////////////////////////////////////*/

    /// @dev Cumulative USDC actually paid out, per drawing and globally. The production
    ///      contract stores no payout history — I5 and I7 are only checkable because the
    ///      harness keeps this shadow ledger.
    mapping(uint256 => uint256) public ghostPaidPerDrawing;
    uint256 public ghostPaidTotal;

    /// @dev The high-water mark of drawings that simultaneously held a POSITIVE pot with at
    ///      least one contributor still unclaimed.
    ///
    ///      I7 is the global-solvency property, and its whole reason to exist is that many
    ///      pots share ONE USDC balance — a per-drawing bound (I5) cannot catch cross-pot
    ///      insolvency. But if the fuzzer only ever funded one drawing at a time, I7 would
    ///      reduce to I5 and pass without ever testing the condition it was written for.
    ///      Counting successful `markWinners` calls does not establish this: all of them can
    ///      land on the same current drawing. So the coexistence itself is measured, and
    ///      `afterInvariant` fails if it never reached two.
    uint256 public maxCoexistingUnclaimedPots;

    /// @dev Distinct drawings that have EVER held a positive pot. Weaker than the above but
    ///      useful for diagnosing which half collapsed when coverage drops.
    uint256 public distinctFundedDrawings;
    mapping(uint256 => bool) internal _wasFunded;

    /*//////////////////////////////////////////////////////////////
                            COVERAGE COUNTERS
    //////////////////////////////////////////////////////////////*/

    uint256 public okJoin;
    uint256 public okClaimBatch;
    uint256 public okClaim;
    uint256 public okRollover;
    uint256 public okMarkWinners;

    constructor(
        FarpotPool _pool,
        MockJackpot _jackpot,
        MockTicketNFT _nft,
        MockRandomTicketBuyer _rtb,
        MockUSDC _usdc
    ) {
        pool = _pool;
        jackpot = _jackpot;
        nft = _nft;
        rtb = _rtb;
        usdc = _usdc;

        for (uint256 i; i < 4; ++i) {
            address a = address(uint160(uint256(keccak256(abi.encode("actor", i)))));
            actors.push(a);
            _usdc.mint(a, 1_000_000e6);
            vm.prank(a);
            _usdc.approve(address(_pool), type(uint256).max);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function touchedCount() external view returns (uint256) {
        return touchedDrawings.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[bound(seed, 0, actors.length - 1)];
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    function join(uint256 actorSeed, uint256 countSeed) external {
        if (pool.paused()) return;

        uint256 d = jackpot.currentDrawingId();
        if (jackpot.getDrawingState(d).jackpotLock) return;

        uint32 n = uint32(bound(countSeed, 1, pool.MAX_TICKETS_PER_JOIN()));
        address who = _actor(actorSeed);

        uint256 cost = n * jackpot.getDrawingState(d).ticketPrice;
        if (usdc.balanceOf(who) < cost) return;

        vm.prank(who);
        pool.join(n);

        if (!_seen[d]) {
            _seen[d] = true;
            touchedDrawings.push(d);
        }
        ++okJoin;
    }

    /// @dev Chooses among drawings that are ACTUALLY claimable rather than picking blindly
    ///      and bailing out. Blind picking wasted most of the call budget — measured runs
    ///      where no drawing ever reached a drained cursor, so `claim` was unreachable and
    ///      the whole settled half of the lifecycle went untested on those seeds. Selecting
    ///      from eligible candidates also mirrors production, where the cron drains settled
    ///      drawings rather than sampling at random. Randomness is preserved in WHICH
    ///      candidate and in the batch size.
    function claimBatch(uint256 drawingSeed, uint256 countSeed) external {
        uint256 d;
        {
            uint256 cur = jackpot.currentDrawingId();
            uint256 len = touchedDrawings.length;
            uint256[] memory candidates = new uint256[](len);
            uint256 c;
            for (uint256 i; i < len; ++i) {
                uint256 t = touchedDrawings[i];
                if (t >= cur) continue; // not settled yet
                (,,,, uint256 cursor, uint256 count) = pool.poolOf(t);
                if (cursor >= count) continue; // already drained
                candidates[c++] = t;
            }
            if (c == 0) return;
            d = candidates[bound(drawingSeed, 0, c - 1)];
        }

        // Bounded below MAX_CLAIM_BATCH (75) rather than at it. Two competing needs, both
        // measured rather than assumed:
        //   - batches must often be SMALLER than the remaining count, so the cursor advances
        //     partially many times — that is where the idempotency risk lives (a slice being
        //     re-covered, or a partial advance failing to roll back);
        //   - but they must be large enough that drawings actually reach a drained cursor,
        //     because `claim` only becomes reachable at `Settled`. Capping at 6 starved
        //     `claim` to 0-4 per run; capping at 40 keeps both paths well exercised.
        // The 75/76 boundary is covered exhaustively by the unit tests, which is where a
        // boundary belongs.
        uint16 n = uint16(bound(countSeed, 1, 40));
        pool.claimBatch(d, n);
        ++okClaimBatch;
        _recordSolvencyCoverage();
    }

    /// @dev Same candidate-selection discipline as `claimBatch`, for the same reason.
    function claim(uint256 actorSeed, uint256 drawingSeed) external {
        uint256 d;
        {
            uint256 len = touchedDrawings.length;
            uint256[] memory candidates = new uint256[](len);
            uint256 c;
            for (uint256 i; i < len; ++i) {
                uint256 t = touchedDrawings[i];
                if (pool.poolStateOf(t) != IFarpotPool.PoolState.Settled) continue;
                candidates[c++] = t;
            }
            if (c == 0) return;
            d = candidates[bound(drawingSeed, 0, c - 1)];
        }

        address who = _actor(actorSeed);
        uint256[] memory ds = new uint256[](1);
        ds[0] = d;

        uint256 before = usdc.balanceOf(who);
        vm.prank(who);
        pool.claim(ds);
        uint256 paid = usdc.balanceOf(who) - before;

        ghostPaidPerDrawing[d] += paid;
        ghostPaidTotal += paid;
        ++okClaim;
        _recordSolvencyCoverage();
    }

    /// @notice Measure how many funded drawings currently have unclaimed entitlements.
    /// @dev Called after every state-changing action, so the high-water mark reflects what
    ///      actually coexisted rather than what happened to be true at the end of a run.
    function _recordSolvencyCoverage() internal {
        uint256 n;
        for (uint256 i; i < touchedDrawings.length; ++i) {
            uint256 d = touchedDrawings[i];
            if (pool.pot(d) == 0) continue;

            if (!_wasFunded[d]) {
                _wasFunded[d] = true;
                ++distinctFundedDrawings;
            }

            for (uint256 a; a < actors.length; ++a) {
                address who = actors[a];
                if (pool.ticketsByUser(d, who) > 0 && !pool.claimed(d, who)) {
                    ++n;
                    break;
                }
            }
        }
        if (n > maxCoexistingUnclaimedPots) maxCoexistingUnclaimedPots = n;
    }

    /// @dev Settlement and rollover are atomic upstream, so this is one write.
    /// @dev Gated on the drawing being WORTH settling, not on a coin flip.
    ///
    ///      A probabilistic gate made lifecycle progress a lottery: each `invariant_*`
    ///      function is its own independent campaign with its own RNG stream, so some
    ///      campaigns rolled over plenty and reached `claim` 34 times while others never
    ///      settled a drawing at all and left the entire settled half of the lifecycle
    ///      untested. That is not coverage worth having, and it made any floor on `claim`
    ///      flaky by construction.
    ///
    ///      Requiring a minimum size before rolling over gives both properties
    ///      deterministically: drawings accumulate enough tickets that draining them takes
    ///      SEVERAL batches (exercising partial cursor advances), and the rollover then
    ///      happens reliably rather than when the dice allow.
    function rollover() external {
        uint256 d = jackpot.currentDrawingId();
        (,,,,, uint256 count) = pool.poolOf(d);
        if (count < 15) return;
        jackpot.setCurrentDrawingId(d + 1);
        ++okRollover;
    }

    /// @notice Make some of the current drawing's pool tickets winners.
    /// @dev Without this every pot is zero, and I5/I7 — the properties that actually matter —
    ///      would be trivially satisfied by a contract that never paid anyone anything.
    function markWinners(uint256 seed, uint256 amountSeed) external {
        uint256 d = jackpot.currentDrawingId();
        uint256 amount = bound(amountSeed, 1, 50e6);
        uint256 want = bound(seed, 1, 3);

        uint256 len = nft.allTokensLength();
        uint256 marked;
        for (uint256 i; i < len && marked < want; ++i) {
            uint256 id = nft.tokenAt(i);
            if (nft.getTicketInfo(id).drawingId != d) continue;
            if (nft.ownerOf(id) != address(pool)) continue;
            if (jackpot.winningsOf(id) != 0) continue;
            jackpot.setWinnings(id, amount);
            ++marked;
        }
        if (marked != 0) ++okMarkWinners;
    }
}

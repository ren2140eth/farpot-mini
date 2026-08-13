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

    /// @dev Drawings `markWinners` has actually put winnings on, so `rollover` can tell a
    ///      drawing that will settle to a payable pot from one that will settle to zero.
    mapping(uint256 => bool) public markedDrawing;

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
    uint256 public okSponsor;
    uint256 public okSponsorFallbackClaim;

    /// @dev Distinct sponsor-only drawings that have actually PAID a fallback claim. This, not
    ///      the raw claim count, is what the steering below targets: several sponsors claiming
    ///      the same pot proves one drawing works, not that the fuzzer can build them.
    uint256 public sponsorOnlyPaidDrawings;
    mapping(uint256 => bool) internal _fallbackPaidDrawing;

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

    /// @notice One drawing in three accepts sponsors only — `join` declines these.
    /// @dev CALIBRATED FROM MEASUREMENT, in the same spirit as the claim-candidate selection
    ///      below. The zero-joiner fallback only pays on a drawing that SETTLES with sponsored
    ///      tickets and no joiner weight at all, and left to chance that is a coin-flip streak:
    ///      `join` and `sponsor` fire at the same rate, so a drawing stays sponsor-only only if
    ///      every one of its ~4-5 buys happened to be a sponsor. Measured over three seeds with
    ///      no reserved lane, a whole run produced 2/0/1 sponsor-only drawings and 0/0/2
    ///      fallback claims — so on most seeds the new payout branch was never executed once,
    ///      and every sponsor invariant held vacuously over it.
    ///
    ///      Reserving a deterministic lane makes that branch reachable EVERY run without
    ///      weakening anything else: the other two drawings in three still take joins and
    ///      sponsors in any order the fuzzer likes, so mixed pools — including the
    ///      sponsor-first-then-joiner ordering that flips the active claimant class, which is
    ///      exactly what I11 exists to check — remain fully covered.
    ///
    ///      The reservation LIFTS once the fallback has paid on two DISTINCT drawings. A
    ///      permanent 1-in-3 lane was measured costing more than it was worth: it dropped a
    ///      run's `okJoin` from ~39-48 to a low tail of 9, tripping the PRE-EXISTING join
    ///      floor of 10 — buying sponsor coverage by quietly starving joiner coverage is not a
    ///      trade worth making, and lowering that floor to hide it would defeat its purpose.
    ///      Lifting the lane confines the cost to the earlier part of a run: across nine seeds
    ///      the reservation closed between call 66 and 159 of 256, and `okJoin`'s low tail
    ///      stayed at 23 against its floor of 10.
    function _isSponsorLane(uint256 drawingId) internal view returns (bool) {
        return _chasingFallback() && drawingId % 3 == 0;
    }

    /*//////////////////////////////////////////////////////////////
                                ACTIONS
    //////////////////////////////////////////////////////////////*/

    function join(uint256 actorSeed, uint256 countSeed) external {
        if (pool.paused()) return;

        uint256 d = jackpot.currentDrawingId();
        if (jackpot.getDrawingState(d).jackpotLock) return;
        if (_isSponsorLane(d)) return;

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

    /// @dev Modelled exactly on `join` — same actor selection, same balance pre-check, same
    ///      early-return-instead-of-revert discipline — because the only difference that
    ///      matters is the one under test: these tickets carry NO payout weight.
    function sponsor(uint256 actorSeed, uint256 countSeed) external {
        if (pool.paused()) return;

        uint256 d = jackpot.currentDrawingId();
        if (jackpot.getDrawingState(d).jackpotLock) return;

        uint32 n = uint32(bound(countSeed, 1, pool.MAX_TICKETS_PER_JOIN()));
        address who = _actor(actorSeed);

        uint256 cost = n * jackpot.getDrawingState(d).ticketPrice;
        if (usdc.balanceOf(who) < cost) return;

        vm.prank(who);
        pool.sponsor(n);

        if (!_seen[d]) {
            _seen[d] = true;
            touchedDrawings.push(d);
        }
        ++okSponsor;
    }

    /// @notice Touched drawings that hold sponsored tickets and no joiner weight at all.
    function okSponsorOnlyDrawings() external view returns (uint256 n) {
        for (uint256 i; i < touchedDrawings.length; ++i) {
            if (_isSponsorOnly(touchedDrawings[i])) ++n;
        }
    }

    function _isSponsorOnly(uint256 drawingId) internal view returns (bool) {
        return pool.totalSponsored(drawingId) > 0 && pool.totalTickets(drawingId) == 0;
    }

    /// @notice True until the zero-joiner fallback has PAID on two DISTINCT drawings this run.
    /// @dev The three actions below steer toward finishing that payout chain while this holds,
    ///      and go back to sampling freely the moment it flips.
    ///
    ///      WHY TWO DISTINCT DRAWINGS, not one claim. Stopping at the first fallback claim left
    ///      the two new floors with no headroom — measured low tails of `okSponsorOnlyDrawings`
    ///      = 2 and `okSponsorFallbackClaim` = 1, the latter sitting exactly ON its floor, so a
    ///      seed change would read as a regression rather than noise. Counting DISTINCT paying
    ///      drawings rather than raw claims is what actually buys headroom on both counters at
    ///      once: several sponsors claiming the same pot proves one drawing works, not that the
    ///      fuzzer can still build them. At a target of two, nine seeds measured low tails of 3
    ///      and 3 — comfortably clear of both floors. A target of three was tried and rejected:
    ///      it pushed the reservation out to call 151-207 of 256 and one seed never reached it
    ///      at all, which is a much larger bias for headroom nobody needs.
    ///
    ///      WHY THE STEERING IS NEEDED. Reserving a sponsor lane makes a sponsor-only drawing
    ///      exist, but existing is not the same as PAYING: the fallback only executes once such
    ///      a drawing has winnings marked on it, is drained to `Settled`, and is then claimed
    ///      by an actor who actually sponsored it. Left to the random walk all four links had
    ///      to line up inside ONE run's call budget, and measurement showed they often did not:
    ///      with the lane but no steering, the fallback floor failed on 4 of 13 invariant
    ///      campaigns on one seed and 8 of 13 on two others.
    ///
    ///      HOW THE FLOORS ARE ACTUALLY SAMPLED — measured, because the arithmetic is easy to
    ///      get backwards. `afterInvariant` runs ONCE PER INVARIANT TEST, not once per run:
    ///      with `FOUNDRY_INVARIANT_RUNS=2` and again with `=8`, a single-test campaign logged
    ///      exactly one invocation. Foundry resets state between runs, so that one invocation
    ///      sees ONE run's worth of `depth` calls — the campaign's last. A whole suite
    ///      therefore evaluates these floors 13 times, once per invariant, no matter whether
    ///      the profile asks for 128 runs or 500. So a per-run probability `p` of finishing
    ///      with no fallback claim shows up as a suite failure risk near `13 x p`, NOT
    ///      `1 - (1-p)^500`; raising `runs` does not sample the floors harder. Any floor
    ///      calibrated here must therefore hold on a SINGLE run's random walk, which is why
    ///      the chain is made reliable rather than the floor made lax.
    ///
    ///      The steering is deliberately NARROW — it only ever picks among choices the action
    ///      could already have made, never invents a new one, and it switches off once TWO
    ///      distinct drawings have paid via the fallback (see WHY TWO DISTINCT DRAWINGS above),
    ///      so the rest of every run is the same unbiased walk as before.
    function _chasingFallback() internal view returns (bool) {
        return sponsorOnlyPaidDrawings < 2;
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
            // While the fallback chain is unfinished, drain sponsor-only pots first if any are
            // waiting — a sponsor-only pot that never reaches `Settled` can never be claimed.
            //
            // This filter and its twin in `claim` were trialled for removal, on the reasoning
            // that a sponsor-only pot is already in the candidate set and gets resampled many
            // times over a 256-call run. Measured over nine seeds, dropping both cost real
            // headroom — `okSponsorFallbackClaim`'s low tail fell from 3 to 2 — and did NOT
            // shorten the biased window (mean close moved 108 -> 118 calls). Headroom won.
            if (_chasingFallback()) {
                uint256 s;
                for (uint256 i; i < c; ++i) {
                    if (_isSponsorOnly(candidates[i])) candidates[s++] = candidates[i];
                }
                if (s != 0) c = s;
            }
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
            if (_chasingFallback()) {
                uint256 s;
                for (uint256 i; i < c; ++i) {
                    if (_isSponsorOnly(candidates[i])) candidates[s++] = candidates[i];
                }
                if (s != 0) c = s;
            }
            d = candidates[bound(drawingSeed, 0, c - 1)];
        }

        // Picking blindly among four actors when only the sponsors of a sponsor-only drawing
        // can be paid turns the last link of the chain into another coin flip.
        address who = _actor(actorSeed);
        if (_chasingFallback() && _isSponsorOnly(d)) {
            address[] memory eligible = new address[](actors.length);
            uint256 e;
            for (uint256 a; a < actors.length; ++a) {
                if (pool.sponsoredByUser(d, actors[a]) > 0 && !pool.claimed(d, actors[a])) {
                    eligible[e++] = actors[a];
                }
            }
            if (e != 0) who = eligible[bound(actorSeed, 0, e - 1)];
        }
        uint256[] memory ds = new uint256[](1);
        ds[0] = d;

        uint256 before = usdc.balanceOf(who);
        vm.prank(who);
        pool.claim(ds);
        uint256 paid = usdc.balanceOf(who) - before;

        ghostPaidPerDrawing[d] += paid;
        ghostPaidTotal += paid;
        ++okClaim;
        // Fallback claims are the only genuinely new payout branch, so they get their own
        // counter. Folding them into okClaim would let a campaign of ordinary joiner claims
        // satisfy the floor while never once exercising the sponsor path.
        if (paid > 0 && pool.totalTickets(d) == 0) {
            ++okSponsorFallbackClaim;
            if (!_fallbackPaidDrawing[d]) {
                _fallbackPaidDrawing[d] = true;
                ++sponsorOnlyPaidDrawings;
            }
        }
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
        // A sponsor-only drawing that rolls over with no winnings marked settles to a ZERO pot,
        // and a zero pot pays nobody — so it can never exercise the fallback no matter how it
        // is claimed afterwards. Holding it open until `markWinners` has landed removes the
        // one link in the chain that pure ordering luck was deciding.
        if (_chasingFallback() && _isSponsorOnly(d) && !markedDrawing[d]) return;
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
        if (marked != 0) {
            markedDrawing[d] = true;
            ++okMarkWinners;
        }
    }
}

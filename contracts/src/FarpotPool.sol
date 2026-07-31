// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {IFarpotPool} from "./interfaces/IFarpotPool.sol";
import {IJackpot} from "./interfaces/IJackpot.sol";
import {IJackpotTicketNFT} from "./interfaces/IJackpotTicketNFT.sol";
import {IRandomTicketBuyer} from "./interfaces/IRandomTicketBuyer.sol";

/// @dev The one ERC20 read SafeTransferLib does not wrap.
interface IERC20Allowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @title FarpotPool
/// @notice A global group-buy pool for Megapot tickets. Anyone joins the pool for the current
///         drawing, the pool buys tickets on their behalf in the same transaction, and after
///         the drawing settles every contributor takes a pro-rata share of what the pool's
///         tickets won.
/// @author Farpot. Patterns (not code) borrowed from Pull Pool (pool.ripe.wtf), MIT.
///
/// @dev **`join` converts USDC to tickets in the same transaction**, so the pool never holds
///      an unspent contribution. That single decision deletes the entire refund surface —
///      no funding targets, no deadlines, no void/refund/reclaim paths — which is the whole
///      safety argument for an unaudited contract holding other people's money.
///
///      Deliberately absent, each absence load-bearing:
///      - **No `onERC721Received`.** Megapot mints with solady `_mint`, so the hook never
///        fires on a mint and would be dead code. Omitting it also makes a stray
///        `safeTransferFrom` into the pool revert.
///      - **No stored lifecycle.** `poolStateOf` derives it on every read, so it cannot go
///        stale when a drawing rolls over with no pool transaction.
///      - **No sweep, rescue, upgrade or skip.** `pause()` is the only owner power and it
///        cannot touch funds. A skip would be the power to forfeit a specific ticket's
///        winnings — exactly the authority this owner model refuses to hold.
contract FarpotPool is IFarpotPool, Ownable, ReentrancyGuard {
    using SafeTransferLib for address;

    /*//////////////////////////////////////////////////////////////
                            CONSTANTS & DEPS
    //////////////////////////////////////////////////////////////*/

    /// @dev Gas-bound, not product-bound: Megapot costs ~827k gas per ticket, so ten is about
    ///      8.6M — below an 11-ticket buy that has already succeeded in production. The cap is
    ///      PER TRANSACTION, so a user may join repeatedly and total pool size is unbounded.
    uint256 public constant override MAX_TICKETS_PER_JOIN = 10;

    /// @dev Megapot's documented ceiling. ~45.1k gas per ticket to claim puts 75 at ~3.4M.
    uint256 public constant override MAX_CLAIM_BATCH = 75;

    /// @dev `stringToHex("farpot-pool", { size: 32 })`. Telemetry only — `_source` is not
    ///      queryable through the Megapot Data API.
    bytes32 internal constant SOURCE = 0x666172706f742d706f6f6c000000000000000000000000000000000000000000;

    /// @dev 100% of the referral fee to the referral wallet.
    uint256 internal constant REFERRAL_SPLIT = 1e18;

    IJackpot public immutable override jackpot;
    IRandomTicketBuyer public immutable override randomTicketBuyer;
    IJackpotTicketNFT public immutable override ticketNft;
    address public immutable override usdc;
    address public immutable override referralWallet;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @dev Internal: exposed only as `poolOf`'s `ticketCount`, never returned wholesale, so
    ///      a large pool cannot make a view uncallable.
    mapping(uint256 => uint256[]) internal ticketIds;

    mapping(uint256 => bool) public override recordedTicket;
    mapping(uint256 => mapping(address => uint256)) public override ticketsByUser;
    mapping(uint256 => mapping(address => bool)) public override claimed;
    mapping(uint256 => uint256) public override totalTickets;
    mapping(uint256 => uint256) public override contributorCount;
    mapping(uint256 => uint256) public override pot;
    mapping(uint256 => uint256) public override claimCursor;
    bool public override paused;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @dev Solidity cannot import addresses from `constants.ts`, so the dependency graph is
    ///      validated CONTRACTUALLY rather than trusted from a deploy script. The five getter
    ///      checks pin the whole graph: a typo in any single address fails at deploy time
    ///      instead of after users have funded a pool.
    constructor(address _jackpot, address _rtb, address _nft, address _usdc, address _ref) {
        if (
            _jackpot == address(0) || _rtb == address(0) || _nft == address(0) || _usdc == address(0)
                || _ref == address(0)
        ) {
            revert ZeroAddress();
        }
        // Would silently recycle referral fees into a contract that cannot spend them.
        if (_ref == address(this)) revert InvalidReferralWallet();
        // The referral wallet MAY be an EOA; the four dependencies may not.
        if (_jackpot.code.length == 0 || _rtb.code.length == 0 || _nft.code.length == 0 || _usdc.code.length == 0) {
            revert NotAContract();
        }
        if (IJackpot(_jackpot).jackpotNFT() != _nft) revert InconsistentDeps();
        if (IJackpot(_jackpot).usdc() != _usdc) revert InconsistentDeps();
        if (IRandomTicketBuyer(_rtb).jackpot() != _jackpot) revert InconsistentDeps();
        if (IRandomTicketBuyer(_rtb).usdc() != _usdc) revert InconsistentDeps();
        if (IJackpotTicketNFT(_nft).jackpot() != _jackpot) revert InconsistentDeps();

        jackpot = IJackpot(_jackpot);
        randomTicketBuyer = IRandomTicketBuyer(_rtb);
        ticketNft = IJackpotTicketNFT(_nft);
        usdc = _usdc;
        referralWallet = _ref;

        _initializeOwner(msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                  JOIN
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IFarpotPool
    function join(uint32 tickets) external override nonReentrant {
        if (paused) revert Paused();
        if (tickets == 0 || tickets > MAX_TICKETS_PER_JOIN) revert InvalidTicketCount();

        // Price is read live and never hardcoded. `jackpotLock` gets its own error so the UI
        // can say "the draw is about to happen, try again shortly" rather than showing an
        // opaque revert.
        IJackpot.DrawingState memory ds = jackpot.getDrawingState(jackpot.currentDrawingId());
        if (ds.jackpotLock) revert PoolLocked();
        uint256 cost = uint256(tickets) * ds.ticketPrice;

        usdc.safeTransferFrom(msg.sender, address(this), cost);
        // Exact amount, never an unlimited standing grant.
        usdc.safeApproveWithRetry(address(randomTicketBuyer), cost);

        address[] memory referrers = new address[](1);
        referrers[0] = referralWallet;
        uint256[] memory split = new uint256[](1);
        split[0] = REFERRAL_SPLIT;

        uint256[] memory ids = randomTicketBuyer.buyTickets(tickets, address(this), referrers, split, SOURCE);

        if (ids.length != tickets) revert MintCountMismatch();
        // The buyer is supposed to consume exactly what it was approved. A residue means it
        // did something other than what we paid for, so refuse rather than leave a standing
        // allowance behind.
        if (IERC20Allowance(usdc).allowance(address(this), address(randomTicketBuyer)) != 0) {
            revert AllowanceResidue();
        }

        // Authoritative: the drawing comes FROM THE TICKETS, not from a separately-read
        // `currentDrawingId()`, so a rollover landing between the two reads cannot
        // misattribute this join.
        uint256 d = ticketNft.getTicketInfo(ids[0]).drawingId;

        // Validate and record in ONE pass, per id.
        //
        // DO NOT split this into "validate everything, then commit everything", however much
        // safer that shape reads. In a two-pass version `recordedTicket` is still false for
        // BOTH occurrences of a repeated id during the validation pass, so a response
        // containing the same id twice sails through and gets recorded twice — over-crediting
        // shares and then permanently jamming the claim cursor, which is unrecoverable
        // because there is deliberately no skip. Writing the flag as we go is what makes the
        // duplicate detectable at all.
        //
        // Megapot's ids are unique by construction, but that is an EXTERNAL contract's
        // implementation detail, not a property of ours, so it is checked rather than trusted.
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            if (recordedTicket[id]) revert DuplicateTicket();
            if (ticketNft.ownerOf(id) != address(this)) revert InvalidTicketOwner();
            if (ticketNft.getTicketInfo(id).drawingId != d) revert MixedDrawing();
            recordedTicket[id] = true;
            ticketIds[d].push(id);
        }

        if (ticketsByUser[d][msg.sender] == 0) ++contributorCount[d];
        ticketsByUser[d][msg.sender] += tickets;
        totalTickets[d] += tickets;

        emit Joined(d, msg.sender, tickets, ids.length);
    }

    /*//////////////////////////////////////////////////////////////
                               CLAIM BATCH
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IFarpotPool
    /// @dev Permissionless and NOT pausable: contributors must always be able to recover
    ///      winnings from drawings already bought, including during an upstream incident when
    ///      joins are paused.
    function claimBatch(uint256 drawingId, uint16 count) external override nonReentrant {
        if (count == 0 || count > MAX_CLAIM_BATCH) revert InvalidBatchSize();

        // Mirrors Megapot's own guard. Settlement and rollover are atomic in
        // `scaledEntropyCallback`, so `d < currentDrawingId` IS "settled" — there is no
        // window where the inequality holds but the drawing is unsettled. This gate is
        // load-bearing: `claimWinnings` does NOT check settlement itself and burns tickets
        // regardless, so claiming against an unset winning ticket would forfeit real
        // winnings for a garbage tier.
        if (drawingId >= jackpot.currentDrawingId()) revert NotSettled();

        uint256[] storage list = ticketIds[drawingId];
        uint256 cur = claimCursor[drawingId];
        uint256 len = list.length;
        if (cur >= len) revert NothingToClaim();

        uint256 n = len - cur;
        if (n > count) n = count;

        uint256[] memory slice = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            slice[i] = list[cur + i];
        }

        // Effects BEFORE the interaction. The cursor is the idempotency invariant: it never
        // re-covers a claimed slice, which matters because re-submitting a burned ticket
        // reverts. If `claimWinnings` reverts the whole transaction rolls back, taking this
        // advance with it.
        claimCursor[drawingId] = cur + n;

        uint256 before = usdc.balanceOf(address(this));
        jackpot.claimWinnings(slice);
        uint256 delta = usdc.balanceOf(address(this)) - before;

        // MEASURED DELTA, never a raw balance read: the contract simultaneously holds other
        // drawings' unclaimed pots plus rounding dust, and a raw read would misattribute them.
        pot[drawingId] += delta;

        emit BatchClaimed(drawingId, n, delta, cur + n);
    }

    /*//////////////////////////////////////////////////////////////
                                  CLAIM
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IFarpotPool
    /// @dev NOT pausable, for the same reason as `claimBatch`.
    function claim(uint256[] calldata drawingIds) external override nonReentrant {
        // Explicitly zeroed. Solidity already zero-initializes value-type locals, so this
        // compiles to the same code — but slither's `uninitialized-local` detector flags the
        // bare declaration, and one known-benign finding in the report costs an auditor more
        // time to dismiss than this line costs to write.
        uint256 owed = 0;

        for (uint256 i; i < drawingIds.length; ++i) {
            uint256 d = drawingIds[i];
            if (poolStateOf(d) != PoolState.Settled) revert NotSettled();

            // Duplicate ids in one call are a no-op after the first, not a double payout.
            if (claimed[d][msg.sender]) continue;
            uint256 w = ticketsByUser[d][msg.sender];
            if (w == 0) continue;

            // The weight is NEVER zeroed, so historical participation stays readable from
            // state after claiming.
            claimed[d][msg.sender] = true;

            // Floor, via the full 512-bit product: the naive `pot * w / total` reverts on
            // overflow, which would strand a pot permanently.
            uint256 amount = FixedPointMathLib.fullMulDiv(pot[d], w, totalTickets[d]);
            owed += amount;

            emit Claimed(d, msg.sender, amount);
        }

        // A zero entitlement is a valid no-op, not a revert.
        if (owed != 0) usdc.safeTransfer(msg.sender, owed);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IFarpotPool
    /// @dev Derived, never stored, so it cannot go stale. Reads `currentDrawingId` EXACTLY
    ///      ONCE — a second read would be both wasteful and a torn-read hazard.
    function poolStateOf(uint256 drawingId) public view override returns (PoolState) {
        uint256 cur = jackpot.currentDrawingId();

        // Current drawing FIRST, so an empty-but-open pool reads `Accumulating` rather than
        // `None` and the frontend can answer "can I join?" from one field.
        if (drawingId == cur) return PoolState.Accumulating;
        if (drawingId > cur) return PoolState.None;

        uint256 len = ticketIds[drawingId].length;
        if (len == 0) return PoolState.None; // past drawing the pool never joined
        if (claimCursor[drawingId] < len) return PoolState.Claimable;
        return PoolState.Settled;
    }

    /// @inheritdoc IFarpotPool
    function poolOf(uint256 drawingId)
        external
        view
        override
        returns (
            uint256 tickets,
            uint256 contributors,
            uint256 potAmount,
            PoolState poolState,
            uint256 cursor,
            uint256 ticketCount
        )
    {
        return (
            totalTickets[drawingId],
            contributorCount[drawingId],
            pot[drawingId],
            poolStateOf(drawingId),
            claimCursor[drawingId],
            ticketIds[drawingId].length
        );
    }

    /// @inheritdoc IFarpotPool
    function shareOf(uint256 drawingId, address who)
        external
        view
        override
        returns (uint256 tickets, uint256 owed, bool hasClaimed)
    {
        tickets = ticketsByUser[drawingId][who];
        hasClaimed = claimed[drawingId][who];

        uint256 total = totalTickets[drawingId];
        // Guarded so a drawing with no participants returns 0 rather than dividing by zero.
        if (!hasClaimed && total != 0) {
            owed = FixedPointMathLib.fullMulDiv(pot[drawingId], tickets, total);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                  OWNER
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IFarpotPool
    function pause() external override onlyOwner {
        paused = true;
        emit PausedSet(true);
    }

    /// @inheritdoc IFarpotPool
    function unpause() external override onlyOwner {
        paused = false;
        emit PausedSet(false);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJackpot} from "./IJackpot.sol";
import {IJackpotTicketNFT} from "./IJackpotTicketNFT.sol";
import {IRandomTicketBuyer} from "./IRandomTicketBuyer.sol";

/// @title IFarpotPool
/// @notice The complete external surface of FarpotPool — lifecycle type, custom errors,
///         events and functions. Pinned before any logic exists so the test suite is written
///         against a fixed shape rather than retrofitted to whatever got built.
/// @dev Anything a contributor, the frontend, the cron or a test can observe belongs here.
///      `ticketIds` is deliberately absent: it is `internal` storage, exposed only through
///      `poolOf`'s `ticketCount`.
interface IFarpotPool {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice A drawing's pool lifecycle, DERIVED on every read — never stored.
    /// @dev ABI-stable order: None=0, Accumulating=1, Claimable=2, Settled=3.
    ///
    ///      Solidity derives enum values from DECLARATION ORDER and rejects explicit
    ///      assignments (`None = 0` is a compile error), so the ordering below is the only
    ///      thing fixing the numbers. Do not reorder or insert; append only. The numeric
    ///      values are asserted in the test suite — those assertions are the guard, since
    ///      the language offers no syntax for one.
    ///
    ///      An earlier design stored this in a mapping but only ever *wrote* `Settled`, so a
    ///      past drawing awaiting settlement reported the zero default. Deriving removes
    ///      that staleness class entirely; invariant I8 exists to fail if a stored `state`
    ///      mapping is ever reintroduced.
    enum PoolState {
        /// @dev A future drawing, or a past drawing the pool never joined.
        None,
        /// @dev The drawing a join would land in. NOT a guarantee that a join will succeed —
        ///      `jackpotLock` and `paused` are enforced independently.
        Accumulating,
        /// @dev Provably settled, but `claimBatch` has not yet drained the cursor. The
        ///      frontend shows "settling…" here and MUST NOT show a payout figure, because
        ///      `shareOf.owed` reflects only the pot collected so far.
        Claimable,
        /// @dev Cursor exhausted; the pot is fixed and contributors may claim.
        Settled
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice `tickets` was zero or above `MAX_TICKETS_PER_JOIN`.
    error InvalidTicketCount();
    /// @notice The current drawing is locked for the draw. The UI says to retry shortly.
    error PoolLocked();
    /// @notice Joining is paused. Added in Phase 4 — the design enumerates 14 errors and
    ///         omits this one, but `pause()` has to revert with SOMETHING, and a bare
    ///         `require` with no reason would give the frontend nothing to key friendly copy
    ///         off. Distinct from `PoolLocked`, which is Megapot's near-draw lock and clears
    ///         by itself; this one clears only when the owner unpauses.
    error Paused();
    /// @notice The buyer returned a different number of ids than the tickets requested.
    error MintCountMismatch();
    /// @notice USDC allowance to the buyer was non-zero after the buy — the pool approves an
    ///         exact amount and expects it fully consumed, never an unlimited standing grant.
    error AllowanceResidue();
    /// @notice An id was returned twice within one response, or was already recorded by an
    ///         earlier join. Uniqueness is guaranteed by Megapot's construction (design
    ///         §2.7) but that is an *external* contract's implementation detail, so the pool
    ///         validates rather than trusts: a duplicate would over-credit shares and then
    ///         permanently jam the claim cursor, which is unrecoverable by design.
    error DuplicateTicket();
    /// @notice A returned id is not owned by the pool.
    error InvalidTicketOwner();
    /// @notice The ids returned by one buy span more than one drawing.
    error MixedDrawing();
    /// @notice The drawing is not settled — it is the current drawing, or a future or
    ///         nonexistent id. Also raised by `claim` while a drawing is still `Claimable`.
    error NotSettled();
    /// @notice The claim cursor for this drawing is already fully drained.
    error NothingToClaim();
    /// @notice `count` was zero or above `MAX_CLAIM_BATCH`.
    error InvalidBatchSize();
    /// @notice A constructor argument was the zero address.
    error ZeroAddress();
    /// @notice The referral wallet was this contract, which would silently recycle fees.
    error InvalidReferralWallet();
    /// @notice A dependency argument had no code. The referral wallet may be an EOA; the
    ///         four dependency contracts may not.
    error NotAContract();
    /// @notice The dependency contracts do not agree with each other. Five getter checks pin
    ///         the whole graph, so a typo in any single address fails at deploy time rather
    ///         than after users have funded a pool.
    error InconsistentDeps();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice A contributor joined `drawingId` with `tickets` tickets.
    /// @param drawingId Indexed so the contributor route filters by drawing instead of
    ///        scanning history.
    /// @param contributor Indexed so a single wallet's joins are directly queryable.
    /// @param tickets Tickets bought in this join.
    /// @param mintedCount Ids actually returned by the buyer. Equal to `tickets` on every
    ///        successful join (`MintCountMismatch` reverts otherwise); emitted separately so
    ///        an off-chain reader can detect drift without re-deriving it.
    event Joined(uint256 indexed drawingId, address indexed contributor, uint256 tickets, uint256 mintedCount);

    /// @notice `count` tickets of `drawingId` were claimed, adding `potDelta` USDC to its pot.
    /// @param potDelta A measured balance delta, never a raw balance read — the contract
    ///        holds several drawings' pots plus rounding dust simultaneously.
    event BatchClaimed(uint256 indexed drawingId, uint256 count, uint256 potDelta, uint256 cursor);

    /// @notice A contributor took their pro-rata share of `drawingId`.
    event Claimed(uint256 indexed drawingId, address indexed contributor, uint256 amount);

    /// @notice Joins were paused or unpaused. Never affects `claimBatch` or `claim`.
    event PausedSet(bool paused);

    /*//////////////////////////////////////////////////////////////
                            CONSTANTS & DEPS
    //////////////////////////////////////////////////////////////*/

    /// @notice Maximum tickets in a single join. Gas-bound, not product-bound: the cap is per
    ///         transaction, so a user may join repeatedly and total pool size is unbounded.
    /// @dev The UI reads this from the contract so the two can never diverge.
    function MAX_TICKETS_PER_JOIN() external view returns (uint256);

    /// @notice Maximum tickets claimed in one `claimBatch`. Megapot's documented ceiling.
    function MAX_CLAIM_BATCH() external view returns (uint256);

    function jackpot() external view returns (IJackpot);
    function randomTicketBuyer() external view returns (IRandomTicketBuyer);
    function ticketNft() external view returns (IJackpotTicketNFT);
    function usdc() external view returns (address);
    function referralWallet() external view returns (address);

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Whether this token id has ever been recorded by the pool. Permanent — never
    ///         cleared on claim, so a burned id can never be re-recorded.
    function recordedTicket(uint256 ticketId) external view returns (bool);

    /// @notice A contributor's immutable weight in a drawing. Never zeroed, so historical
    ///         participation stays readable from state after claiming.
    function ticketsByUser(uint256 drawingId, address who) external view returns (uint256);

    function claimed(uint256 drawingId, address who) external view returns (bool);
    function totalTickets(uint256 drawingId) external view returns (uint256);
    function contributorCount(uint256 drawingId) external view returns (uint256);

    /// @notice USDC collected for a drawing, accumulated from measured deltas only.
    function pot(uint256 drawingId) external view returns (uint256);

    /// @notice How far `claimBatch` has drained this drawing's ticket list. The idempotency
    ///         invariant: it never re-covers a claimed slice, which matters because
    ///         re-submitting a burned ticket reverts.
    function claimCursor(uint256 drawingId) external view returns (uint256);

    /// @notice Whether joining is paused. `claimBatch` and `claim` are never blocked.
    function paused() external view returns (bool);

    /*//////////////////////////////////////////////////////////////
                                MUTATIVE
    //////////////////////////////////////////////////////////////*/

    /// @notice Buy `tickets` pooled tickets for the current drawing, in this transaction.
    /// @dev USDC becomes tickets inside this call, so the pool never holds an unspent
    ///      contribution and needs no refund path at all. If the Megapot buy reverts, the
    ///      whole join reverts and the joiner keeps their USDC.
    function join(uint32 tickets) external;

    /// @notice Permissionless. Claim up to `count` of a settled drawing's tickets into its pot.
    /// @dev Not blocked by `paused`: contributors must always be able to recover winnings
    ///      from drawings already bought, including during an upstream incident.
    function claimBatch(uint256 drawingId, uint16 count) external;

    /// @notice Take your pro-rata share of each fully-settled drawing in `drawingIds`.
    /// @dev Duplicate ids within one call pay once. A zero entitlement is a no-op, not a
    ///      revert. Not blocked by `paused`.
    function claim(uint256[] calldata drawingIds) external;

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice The derived lifecycle state of `drawingId`. Total: every id maps to exactly
    ///         one state, and no value can go stale because nothing is stored.
    function poolStateOf(uint256 drawingId) external view returns (PoolState);

    function poolOf(uint256 drawingId)
        external
        view
        returns (
            uint256 tickets,
            uint256 contributors,
            uint256 potAmount,
            PoolState poolState,
            uint256 cursor,
            uint256 ticketCount
        );

    /// @notice One contributor's position in a drawing.
    /// @return tickets Always the immutable historical weight, retained after claiming.
    /// @return owed Zero before settlement; a partial figure while `Claimable`; the final
    ///         floor entitlement once `Settled`; zero again once claimed. The UI must show a
    ///         payout figure ONLY when `poolStateOf == Settled`.
    /// @return hasClaimed Whether this contributor has already taken their share.
    function shareOf(uint256 drawingId, address who)
        external
        view
        returns (uint256 tickets, uint256 owed, bool hasClaimed);

    /*//////////////////////////////////////////////////////////////
                                  OWNER
    //////////////////////////////////////////////////////////////*/

    /// @notice Pause joining. The ONLY owner power, and it cannot touch funds: there is no
    ///         sweep, no rescue, no upgrade and no skip. A compromised owner key can stop
    ///         new joins and nothing else.
    function pause() external;

    function unpause() external;
}

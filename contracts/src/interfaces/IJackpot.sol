// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IJackpot
/// @notice Minimal interface for Megapot's v2 Jackpot on Base
///         (`0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2`) — only the members FarpotPool
///         calls, plus the two getters its constructor uses to pin the dependency graph.
/// @dev Every signature below was confirmed against live Base mainnet on 2026-07-30, not
///      copied from documentation. See design §2.
interface IJackpot {
    /// @notice One drawing's full state, returned by `getDrawingState`.
    /// @dev All members are static, so the struct ABI-encodes inline with **no** leading
    ///      offset word — confirmed by decoding a live return blob. Declaring these 13
    ///      fields as flat outputs instead of one tuple is the exact defect that once made
    ///      every named read in the frontend `undefined` (see AGENTS.md); the tuple form is
    ///      what makes `.ticketPrice` / `.jackpotLock` resolve by name.
    struct DrawingState {
        uint256 prizePool;
        uint256 ticketPrice;
        uint256 edgePerTicket;
        uint256 referralWinShare;
        uint256 referralFee;
        uint256 globalTicketsBought;
        uint256 lpEarnings;
        uint64 drawingTime;
        bytes32 winningTicket;
        uint8 ballMax;
        uint8 bonusballMax;
        address payoutCalculator;
        bool jackpotLock;
    }

    /// @notice One picked ticket: five normals plus a bonusball.
    /// @dev Only used by the pick-your-own `buyTickets` overload below. FarpotPool never
    ///      builds one — pool tickets are on-chain random via the RandomTicketBuyer.
    struct Ticket {
        uint8[] normals;
        uint8 bonusball;
    }

    /// @notice The drawing currently open for buying.
    /// @dev Load-bearing: `d < currentDrawingId()` ⟺ drawing `d` is fully settled, because
    ///      settlement and rollover are atomic inside `scaledEntropyCallback` (design §2.2).
    ///      This is the single settled predicate for the whole pool. Do NOT replace it with
    ///      `winningTicket != 0`, which can over-gate and strand funds permanently.
    function currentDrawingId() external view returns (uint256);

    /// @notice Full state for `drawingId`. Future/nonexistent ids return an all-zero struct.
    function getDrawingState(uint256 drawingId) external view returns (DrawingState memory);

    /// @notice Buy tickets with caller-chosen numbers.
    /// @return ticketIds The minted ERC-721 token ids, in mint order.
    /// @dev **Returns the minted ids.** Megapot mints with solady `_mint`, which never fires
    ///      `onERC721Received` (design §2.3), so this return value is the ONLY enumeration
    ///      path available to a contract recipient. `src/lib/constants.ts` declared
    ///      `outputs: []` here until Phase 2 corrected it; proven by decoding a live return.
    function buyTickets(
        Ticket[] calldata _tickets,
        address _recipient,
        address[] calldata _referrers,
        uint256[] calldata _referralSplit,
        bytes32 _source
    ) external returns (uint256[] memory ticketIds);

    /// @notice Burn the given tickets and pay their winnings in USDC to `msg.sender`.
    /// @dev Tolerates losers and batches spanning several settled drawings; only an
    ///      already-claimed id reverts (`TokenDoesNotExist()`), which is why the pool's
    ///      cursor must never re-cover a claimed slice. It does NOT check that a drawing is
    ///      settled and burns regardless, so the caller's own settled-gate is load-bearing.
    function claimWinnings(uint256[] calldata _userTicketIds) external;

    /// @notice The ticket NFT this Jackpot mints through.
    /// @dev Assigned only inside one-shot `initialize()`, already consumed on the live
    ///      Jackpot, so it cannot be swapped (design §8). Used as a constructor cross-check.
    function jackpotNFT() external view returns (address);

    /// @notice The USDC token this Jackpot settles in. Constructor cross-check.
    function usdc() external view returns (address);
}

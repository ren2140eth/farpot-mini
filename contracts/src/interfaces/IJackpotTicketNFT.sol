// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IJackpotTicketNFT
/// @notice Minimal interface for Megapot's JackpotTicketNFT on Base
///         (`0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4`).
/// @dev Deliberately limited to what FarpotPool calls, plus the `jackpot()` constructor
///      cross-check. Notably absent: `transferFrom` / `safeTransferFrom` — the pool has no
///      transfer function and grants no approvals, which is what makes a cursor jam
///      unreachable through anything we expose (design §4). Tests that need to move a token
///      declare that themselves. Signatures confirmed live on 2026-07-30 against a real
///      token id, which returned `drawingId 129` under both accessors below.
interface IJackpotTicketNFT {
    /// @notice A ticket's binding to its drawing.
    struct TrackedTicket {
        uint256 drawingId;
        uint256 packedTicket;
        bytes32 referralScheme;
    }

    /// @notice Current owner of `tokenId`. Reverts once the ticket has been burned by a claim.
    /// @dev The pool asserts `ownerOf(id) == address(this)` for every id it records, so a
    ///      buyer returning ids minted to someone else can never enter the accounting.
    function ownerOf(uint256 tokenId) external view returns (address);

    /// @notice The authoritative ticket→drawing binding.
    /// @dev The pool derives a join's drawing from `getTicketInfo(ids[0]).drawingId` rather
    ///      than from a separately-read `currentDrawingId()`, so a rollover landing between
    ///      the two reads cannot misattribute a join (design §2.5).
    function getTicketInfo(uint256 tokenId) external view returns (TrackedTicket memory);

    /// @notice Public-mapping getter for the same data as `getTicketInfo`, flattened.
    /// @dev Retained as an independent cross-check in tests; the pool itself uses
    ///      `getTicketInfo`.
    function tickets(uint256 tokenId)
        external
        view
        returns (uint256 drawingId, uint256 packedTicket, bytes32 referralScheme);

    /// @notice The Jackpot allowed to mint and burn these tickets. Constructor cross-check.
    function jackpot() external view returns (address);
}

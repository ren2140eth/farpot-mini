// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IRandomTicketBuyer
/// @notice Minimal interface for Megapot's JackpotRandomTicketBuyer on Base
///         (`0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd`).
/// @dev This is the pool's only buy path: pool tickets are on-chain random by design, so
///      FarpotPool never calls the Jackpot's pick-your-own overload. Signatures confirmed
///      against live Base mainnet on 2026-07-30.
interface IRandomTicketBuyer {
    /// @notice Buy `_count` randomly-numbered tickets for `_recipient`.
    /// @return ticketIds The minted ERC-721 token ids, in mint order.
    /// @dev Pulls `_count * ticketPrice` USDC from `msg.sender` and approves the Jackpot for
    ///      exactly that amount, so an exact-value `forceApprove` before the call leaves a
    ///      zero residue after it — which FarpotPool asserts (`AllowanceResidue`).
    ///      Reverts `InvalidTicketCount()` on `_count == 0` and `InvalidRecipient()` on a
    ///      zero recipient. Reads `currentDrawingId` itself; the pool does not rely on that,
    ///      deriving the drawing from the minted tickets instead (design §2.5).
    ///      Ids are `keccak256` outputs — unique by construction but **not** monotonic, so
    ///      never validate them by ordering (design §2.7).
    function buyTickets(
        uint256 _count,
        address _recipient,
        address[] calldata _referrers,
        uint256[] calldata _referralSplit,
        bytes32 _source
    ) external returns (uint256[] memory ticketIds);

    /// @notice The Jackpot this buyer routes to. Constructor cross-check.
    function jackpot() external view returns (address);

    /// @notice The USDC token this buyer pulls. Constructor cross-check.
    function usdc() external view returns (address);
}

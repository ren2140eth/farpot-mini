// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRandomTicketBuyer} from "../../src/interfaces/IRandomTicketBuyer.sol";
import {MockJackpot} from "./MockJackpot.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice Stand-in for Megapot's JackpotRandomTicketBuyer, with injectable misbehaviour.
/// @dev This mock exists for the cases the REAL contracts cannot produce. Megapot's ticket
///      ids are unique by construction (design §2.7), so a fork test can never hand the pool
///      a duplicate, a foreign-owned id, or a short array — yet FarpotPool validates every
///      one of those anyway, because that uniqueness is an external contract's implementation
///      detail rather than a property of ours. A duplicate slipping through would over-credit
///      shares and then permanently jam the claim cursor, which is unrecoverable by design.
///      Without these injectable modes that validation code would be entirely untested.
///
///      Honest behaviour (`Misbehaviour.None`) mirrors the real contract: pull the exact cost
///      from `msg.sender`, forward it to the Jackpot, mint `_count` tickets to `_recipient`,
///      and return their ids. The exact pull is what leaves a zero allowance behind, which
///      FarpotPool asserts.
contract MockRandomTicketBuyer is IRandomTicketBuyer {
    /// @notice How this buyer should misbehave on the next call.
    enum Misbehaviour {
        /// @dev Faithful to the real contract.
        None,
        /// @dev Returns the correct number of ids, but one appears twice. Requires `_count >= 2`.
        DuplicateInResponse,
        /// @dev Mints the id at `foreignIndex` to `foreignOwner` instead of the recipient.
        ///      Set `foreignIndex > 0` to prove the join rolls back ids already validated.
        ForeignOwner,
        /// @dev Returns one fewer id than requested.
        ShortArray,
        /// @dev Returns one more id than requested.
        LongArray,
        /// @dev Returns a caller-supplied id set verbatim without minting — used to replay
        ///      ids the pool already recorded in an earlier join. The array MUST be the
        ///      length the test requests, or `MintCountMismatch` fires first and masks the
        ///      `DuplicateTicket` this mode is meant to provoke.
        ReplayIds,
        /// @dev Mints index 0 into the current drawing and the rest `mixedDrawingOffset`
        ///      drawings later, so the returned ids span two drawings.
        MixedDrawing,
        /// @dev Pulls one atomic unit less than approved, leaving an allowance residue.
        AllowanceResidue
    }

    address public override jackpot;
    address public override usdc;

    Misbehaviour public mode;
    address public foreignOwner;
    uint256 public foreignIndex;
    uint256 public mixedDrawingOffset = 1;
    uint256[] internal _replayIds;

    /// @dev Last-call capture. The referral wallet reaching `_referrers[0]` is the revenue
    ///      path — a silent drop earns nothing — so tests assert on these directly rather
    ///      than trusting that the call was shaped correctly.
    uint256 public lastCount;
    address public lastRecipient;
    bytes32 public lastSource;
    uint256 public callCount;
    address[] internal _lastReferrers;
    uint256[] internal _lastReferralSplit;

    constructor(address _jackpot, address _usdc) {
        jackpot = _jackpot;
        usdc = _usdc;
    }

    /*//////////////////////////////////////////////////////////////
                              TEST CONTROLS
    //////////////////////////////////////////////////////////////*/

    function setMode(Misbehaviour m) external {
        mode = m;
    }

    function setForeignOwner(address who) external {
        foreignOwner = who;
    }

    function setForeignIndex(uint256 i) external {
        foreignIndex = i;
    }

    function setMixedDrawingOffset(uint256 o) external {
        mixedDrawingOffset = o;
    }

    function setReplayIds(uint256[] calldata ids) external {
        _replayIds = ids;
    }

    /// @dev Mutable so a test can present an inconsistent dependency graph to FarpotPool's
    ///      constructor (wrong `jackpot()` or wrong `usdc()`).
    function setJackpot(address _jackpot) external {
        jackpot = _jackpot;
    }

    function setUsdc(address _usdc) external {
        usdc = _usdc;
    }

    function getLastReferrers() external view returns (address[] memory) {
        return _lastReferrers;
    }

    function getLastReferralSplit() external view returns (uint256[] memory) {
        return _lastReferralSplit;
    }

    /*//////////////////////////////////////////////////////////////
                                  BUY
    //////////////////////////////////////////////////////////////*/

    /// @dev Deliberately thin, delegating to `_record` / `_collect` / `_mintPerMode`. Keeping
    ///      the calldata arrays, the captures and the per-mode locals in one body overflows
    ///      the stack under the pinned solc without `via_ir`, and turning `via_ir` on for the
    ///      whole project to satisfy a mock would change how the real contract is compiled.
    function buyTickets(
        uint256 _count,
        address _recipient,
        address[] calldata _referrers,
        uint256[] calldata _referralSplit,
        bytes32 _source
    ) external override returns (uint256[] memory ticketIds) {
        _record(_count, _recipient, _referrers, _referralSplit, _source);
        (MockJackpot j, uint256 d) = _collect(_count);
        return _mintPerMode(j, _recipient, d, _count);
    }

    function _record(
        uint256 _count,
        address _recipient,
        address[] calldata _referrers,
        uint256[] calldata _referralSplit,
        bytes32 _source
    ) internal {
        lastCount = _count;
        lastRecipient = _recipient;
        _lastReferrers = _referrers;
        _lastReferralSplit = _referralSplit;
        lastSource = _source;
        ++callCount;
    }

    /// @notice Pull the ticket cost from the caller and forward it to the Jackpot.
    /// @dev The real buyer pulls exactly the cost from the caller, then the Jackpot pulls
    ///      that from the buyer. Forwarding keeps the mock economy self-consistent: ticket
    ///      revenue accumulates where winnings are paid from. Pulling the EXACT cost is what
    ///      leaves a zero allowance behind, which FarpotPool asserts.
    function _collect(uint256 _count) internal returns (MockJackpot j, uint256 d) {
        j = MockJackpot(jackpot);
        d = j.currentDrawingId();
        uint256 cost = _count * j.getDrawingState(d).ticketPrice;
        uint256 pull = mode == Misbehaviour.AllowanceResidue && cost != 0 ? cost - 1 : cost;
        if (pull != 0) {
            require(MockUSDC(usdc).transferFrom(msg.sender, address(this), pull), "pull failed");
            require(MockUSDC(usdc).transfer(jackpot, pull), "forward failed");
        }
    }

    function _mintPerMode(MockJackpot j, address _recipient, uint256 d, uint256 _count)
        internal
        returns (uint256[] memory ticketIds)
    {
        if (mode == Misbehaviour.ReplayIds) return _replayIds;

        if (mode == Misbehaviour.ShortArray) {
            return _mintRun(j, _recipient, d, _count == 0 ? 0 : _count - 1);
        }
        if (mode == Misbehaviour.LongArray) {
            return _mintRun(j, _recipient, d, _count + 1);
        }
        if (mode == Misbehaviour.DuplicateInResponse) {
            ticketIds = _mintRun(j, _recipient, d, _count);
            if (_count >= 2) ticketIds[_count - 1] = ticketIds[0];
            return ticketIds;
        }
        if (mode == Misbehaviour.ForeignOwner) {
            ticketIds = new uint256[](_count);
            for (uint256 i; i < _count; ++i) {
                address to = i == foreignIndex ? foreignOwner : _recipient;
                ticketIds[i] = j.mintFor(to, d);
            }
            return ticketIds;
        }
        if (mode == Misbehaviour.MixedDrawing) {
            ticketIds = new uint256[](_count);
            for (uint256 i; i < _count; ++i) {
                ticketIds[i] = j.mintFor(_recipient, i == 0 ? d : d + mixedDrawingOffset);
            }
            return ticketIds;
        }

        return _mintRun(j, _recipient, d, _count);
    }

    function _mintRun(MockJackpot j, address to, uint256 d, uint256 n)
        internal
        returns (uint256[] memory ids)
    {
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = j.mintFor(to, d);
        }
    }
}

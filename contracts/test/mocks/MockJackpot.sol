// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJackpot} from "../../src/interfaces/IJackpot.sol";
import {MockTicketNFT} from "./MockTicketNFT.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice Stand-in for Megapot's v2 Jackpot.
/// @dev Models the four behaviours FarpotPool actually depends on, each verified against
///      live Base mainnet (design §2):
///        1. `currentDrawingId` is mutable, so rollover can be simulated with no pool
///           transaction in between — the exact case a stored lifecycle got wrong.
///        2. `claimWinnings` tolerates losers and mixed settled drawings, and reverts only
///           on an already-claimed id (surfacing here as `TokenDoesNotExist` out of
///           `ownerOf`, same as the real one).
///        3. It does NOT check settlement itself and burns regardless — so the caller's own
///           gate is load-bearing. Reproduced faithfully: only the future-drawing guard is
///           enforced, and that mirrors Megapot's `TicketFromFutureDrawing`.
///        4. Ticket ids are keccak outputs — unique by construction but NOT monotonic, so
///           any ordering-based validation would revert on legitimate buys.
contract MockJackpot is IJackpot {
    error EmptyTicketArray();
    error TicketFromFutureDrawing();
    error NotTicketOwner();
    error NotAuthorizedMinter();

    /// @dev Mutable so a test can present an inconsistent dependency graph to FarpotPool's
    ///      constructor, and so the upstream-NFT-replacement scenario can be simulated (it
    ///      cannot be induced on a fork: `initialize()` is one-shot and already consumed).
    address public override jackpotNFT;
    address public override usdc;

    uint256 public override currentDrawingId;

    mapping(uint256 => DrawingState) internal _drawingState;
    /// @dev Winnings paid per ticket id on claim. Unset ids pay zero, i.e. they are losers —
    ///      which is the common case and must never poison a batch.
    mapping(uint256 => uint256) public winningsOf;
    mapping(address => bool) public authorizedMinter;

    uint256 internal _globalCounter;

    constructor(address _nft, address _usdc, uint256 _currentDrawingId) {
        jackpotNFT = _nft;
        usdc = _usdc;
        currentDrawingId = _currentDrawingId;
        // Sensible default so tests need not configure price on every drawing: $1, unlocked.
        _drawingState[_currentDrawingId].ticketPrice = 1e6;
    }

    /*//////////////////////////////////////////////////////////////
                              TEST CONTROLS
    //////////////////////////////////////////////////////////////*/

    function setJackpotNFT(address _nft) external {
        jackpotNFT = _nft;
    }

    function setUsdc(address _usdc) external {
        usdc = _usdc;
    }

    /// @notice Advance (or rewind) the drawing pointer, simulating settlement + rollover.
    /// @dev Settlement and rollover are ATOMIC upstream, so this single write is the
    ///      faithful model: there is no intermediate state in which `d < currentDrawingId`
    ///      yet `d` is unsettled. Carries the previous drawing's ticket price forward so a
    ///      test that rolls over does not silently end up with a zero-price drawing.
    function setCurrentDrawingId(uint256 d) external {
        if (_drawingState[d].ticketPrice == 0) {
            _drawingState[d].ticketPrice = _drawingState[currentDrawingId].ticketPrice;
        }
        currentDrawingId = d;
    }

    function setTicketPrice(uint256 d, uint256 price) external {
        _drawingState[d].ticketPrice = price;
    }

    function setJackpotLock(uint256 d, bool locked) external {
        _drawingState[d].jackpotLock = locked;
    }

    function setDrawingTime(uint256 d, uint64 t) external {
        _drawingState[d].drawingTime = t;
    }

    function setWinningTicket(uint256 d, bytes32 w) external {
        _drawingState[d].winningTicket = w;
    }

    /// @notice Mark a ticket as a winner worth `amount` USDC on claim.
    function setWinnings(uint256 ticketId, uint256 amount) external {
        winningsOf[ticketId] = amount;
    }

    /// @notice Allow `who` (the RandomTicketBuyer mock) to mint through this Jackpot.
    function setAuthorizedMinter(address who, bool allowed) external {
        authorizedMinter[who] = allowed;
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function getDrawingState(uint256 drawingId) external view override returns (DrawingState memory) {
        return _drawingState[drawingId];
    }

    /*//////////////////////////////////////////////////////////////
                                MINTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint one ticket for `to` in `drawingId`, returning its id.
    /// @dev Id derivation mirrors Megapot's: `keccak256(drawingId, strictly-increasing
    ///      counter, packedTicket)`. The counter guarantees uniqueness; hashing guarantees
    ///      the ids are NOT ordered, so a test suite built on this mock will catch any
    ///      ordering-based validation that would break on real buys (design §2.7).
    function mintFor(address to, uint256 drawingId) public returns (uint256 id) {
        if (!authorizedMinter[msg.sender] && msg.sender != address(this)) {
            revert NotAuthorizedMinter();
        }
        uint256 packedTicket = uint256(keccak256(abi.encode("packed", ++_globalCounter)));
        id = uint256(keccak256(abi.encode(drawingId, _globalCounter, packedTicket)));
        MockTicketNFT(jackpotNFT).mintTicket(to, id, drawingId, packedTicket);
    }

    /// @notice Pick-your-own buy. Present because the real Jackpot has it and the corrected
    ///         `uint256[]` return type is the whole point of the ABI fix; FarpotPool itself
    ///         only ever buys through the RandomTicketBuyer.
    function buyTickets(Ticket[] calldata _tickets, address _recipient, address[] calldata, uint256[] calldata, bytes32)
        external
        override
        returns (uint256[] memory ticketIds)
    {
        ticketIds = new uint256[](_tickets.length);
        for (uint256 i; i < _tickets.length; ++i) {
            ticketIds[i] = mintFor(_recipient, currentDrawingId);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                CLAIMING
    //////////////////////////////////////////////////////////////*/

    /// @dev Deliberately does NOT verify that a drawing is settled beyond the future-drawing
    ///      guard, and burns regardless — faithful to the real contract, and the reason
    ///      FarpotPool's own `d < currentDrawingId()` gate must never be relaxed on the
    ///      assumption that Megapot re-checks.
    function claimWinnings(uint256[] calldata _userTicketIds) external override {
        if (_userTicketIds.length == 0) revert EmptyTicketArray();
        MockTicketNFT nft = MockTicketNFT(jackpotNFT);
        uint256 total;
        for (uint256 i; i < _userTicketIds.length; ++i) {
            uint256 id = _userTicketIds[i];
            // Reverts TokenDoesNotExist for an already-claimed (burned) ticket — the one
            // input that must never be re-submitted, which is what the cursor guarantees.
            if (nft.ownerOf(id) != msg.sender) revert NotTicketOwner();
            if (nft.getTicketInfo(id).drawingId >= currentDrawingId) {
                revert TicketFromFutureDrawing();
            }
            nft.burnTicket(id);
            total += winningsOf[id];
        }
        if (total != 0) require(MockUSDC(usdc).transfer(msg.sender, total), "payout failed");
    }
}

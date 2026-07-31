// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";

import {IFarpotPool} from "./interfaces/IFarpotPool.sol";
import {IJackpot} from "./interfaces/IJackpot.sol";
import {IJackpotTicketNFT} from "./interfaces/IJackpotTicketNFT.sol";
import {IRandomTicketBuyer} from "./interfaces/IRandomTicketBuyer.sol";

/// @title FarpotPool
/// @author Farpot. Patterns (not code) borrowed from Pull Pool (pool.ripe.wtf), MIT.
///
/// @notice ############################################################################
///         #  PHASE 3 SKELETON — THIS IS NOT THE CONTRACT. DO NOT DEPLOY.             #
///         ############################################################################
///
///         Storage layout, immutables and the external surface are final (design §4);
///         every behaviour is `revert Unimplemented()`. It exists so the Phase 3 test
///         suite compiles and fails for the RIGHT reason — an unimplemented body —
///         rather than on a missing symbol, which proves nothing about anything.
///
///         Phase 4 replaces each body per the §4 pseudocode. A test still failing with
///         `Unimplemented` after Phase 4 is a body that was never written.
///
/// @dev Deliberately absent, and each absence is load-bearing:
///      - **No `onERC721Received`.** Megapot mints with solady `_mint`, so the hook is
///        never called on a mint and it would be dead code (design §2.3). Omitting it
///        also makes a stray `safeTransferFrom` into the pool revert.
///      - **No `state` mapping.** The lifecycle is derived on every read (§4.2); a
///        stored one went stale in an earlier design. Invariant I8 fails if it returns.
///      - **No sweep, no rescue, no upgrade, no skip.** The owner's only power is
///        pausing joins. A skip would be the power to forfeit a specific ticket's
///        winnings, which is exactly the authority this owner model refuses to hold.
contract FarpotPool is IFarpotPool, Ownable {
    /// @dev Phase 3 marker ONLY. Not part of the design's error set, and it must not
    ///      survive Phase 4 — its presence in shipped bytecode means a body is missing.
    error Unimplemented();

    /*//////////////////////////////////////////////////////////////
                            CONSTANTS & DEPS
    //////////////////////////////////////////////////////////////*/

    /// @dev Gas-bound at 10 (design §4.1), pending the Phase 5 fork confirmation that
    ///      `join(10)` stays under 12M. Tests read it from here rather than hardcoding,
    ///      so the boundary cases track the constant if Phase 5 lowers it.
    uint256 public constant override MAX_TICKETS_PER_JOIN = 10;
    uint256 public constant override MAX_CLAIM_BATCH = 75;

    /// @dev `stringToHex("farpot-pool", { size: 32 })`.
    bytes32 internal constant SOURCE = 0x666172706f742d706f6f6c000000000000000000000000000000000000000000;

    IJackpot public immutable override jackpot;
    IRandomTicketBuyer public immutable override randomTicketBuyer;
    IJackpotTicketNFT public immutable override ticketNft;
    address public immutable override usdc;
    address public immutable override referralWallet;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @dev Internal: exposed only as `poolOf`'s `ticketCount`. The full array is never
    ///      returned, so a large pool cannot make a view uncallable.
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

    /// @dev PHASE 3: assignment only. The five-check validation (zero addresses, the
    ///      referral wallet not being this contract, four dependencies having code, and
    ///      five getters pinning the graph) is Phase 4 — so the constructor-rejection
    ///      tests currently fail by NOT reverting, which is the correct pending state.
    constructor(address _jackpot, address _rtb, address _nft, address _usdc, address _ref) {
        jackpot = IJackpot(_jackpot);
        randomTicketBuyer = IRandomTicketBuyer(_rtb);
        ticketNft = IJackpotTicketNFT(_nft);
        usdc = _usdc;
        referralWallet = _ref;
        _initializeOwner(msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                MUTATIVE
    //////////////////////////////////////////////////////////////*/

    function join(uint32) external override {
        revert Unimplemented();
    }

    function claimBatch(uint256, uint16) external override {
        revert Unimplemented();
    }

    function claim(uint256[] calldata) external override {
        revert Unimplemented();
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    function poolStateOf(uint256) public view override returns (PoolState) {
        revert Unimplemented();
    }

    function poolOf(uint256) external view override returns (uint256, uint256, uint256, PoolState, uint256, uint256) {
        revert Unimplemented();
    }

    function shareOf(uint256, address) external view override returns (uint256, uint256, bool) {
        revert Unimplemented();
    }

    /*//////////////////////////////////////////////////////////////
                                  OWNER
    //////////////////////////////////////////////////////////////*/

    function pause() external override {
        revert Unimplemented();
    }

    function unpause() external override {
        revert Unimplemented();
    }
}

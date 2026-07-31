// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJackpotTicketNFT} from "../../src/interfaces/IJackpotTicketNFT.sol";

/// @notice Stand-in for Megapot's JackpotTicketNFT.
/// @dev Written from scratch rather than inheriting a library ERC721, because the single
///      most load-bearing property here is a NEGATIVE one: **`mint` must not invoke
///      `onERC721Received`**. Megapot mints with solady `_mint` (design §2.3), so a contract
///      recipient gets no callback — which is why FarpotPool enumerates from the buy return
///      value instead of a hook. An earlier design made that hook the sole enumeration
///      mechanism and would have recorded zero tickets forever. Inheriting a library whose
///      internals might safe-mint would quietly destroy the very thing this mock exists to
///      model, so the mint path below is deliberately explicit and hook-free.
///
///      `safeTransferFrom` DOES fire the hook, which is what makes a stray safe-transfer into
///      the pool revert (the pool implements no receiver).
contract MockTicketNFT is IJackpotTicketNFT {
    error TokenDoesNotExist();
    error TokenAlreadyExists();
    error NotJackpot();
    error NotAuthorized();
    error TransferToNonERC721ReceiverImplementer();

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    /// @dev Mutable so a test can point the NFT at a different Jackpot and exercise the
    ///      inconsistent-dependency-graph branch of FarpotPool's constructor.
    address public override jackpot;

    mapping(uint256 => address) internal _ownerOf;
    mapping(uint256 => TrackedTicket) internal _info;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    /// @dev Every id ever minted, in mint order, retained after burning.
    ///      Added in Phase 3: `FarpotPool.ticketIds` is internal storage with no element
    ///      accessor, so the invariant suite needs some way to enumerate the pool's tickets.
    ///      Enumerating from the token side rather than reaching into the pool's storage
    ///      slots keeps the invariants a statement about OBSERVABLE behaviour — they stay
    ///      true if Phase 4 lays storage out differently, and they cannot silently pass
    ///      because a slot calculation drifted.
    uint256[] internal _allTokens;

    constructor(address _jackpot) {
        jackpot = _jackpot;
    }

    function setJackpot(address _jackpot) external {
        jackpot = _jackpot;
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @dev Reverts for a burned or never-minted id, exactly as solady's does. That is what
    ///      makes a re-submitted (already-claimed) ticket revert in `claimWinnings`.
    function ownerOf(uint256 tokenId) public view override returns (address owner) {
        owner = _ownerOf[tokenId];
        if (owner == address(0)) revert TokenDoesNotExist();
    }

    function getTicketInfo(uint256 tokenId) external view override returns (TrackedTicket memory) {
        return _info[tokenId];
    }

    function tickets(uint256 tokenId)
        external
        view
        override
        returns (uint256 drawingId, uint256 packedTicket, bytes32 referralScheme)
    {
        TrackedTicket memory t = _info[tokenId];
        return (t.drawingId, t.packedTicket, t.referralScheme);
    }

    function exists(uint256 tokenId) external view returns (bool) {
        return _ownerOf[tokenId] != address(0);
    }

    function allTokensLength() external view returns (uint256) {
        return _allTokens.length;
    }

    function tokenAt(uint256 i) external view returns (uint256) {
        return _allTokens[i];
    }

    /// @notice Live tickets `owner` holds for `drawingId`. Burned tickets are excluded, so
    ///         this counts exactly the unclaimed tail.
    function balanceOfDrawing(address owner, uint256 drawingId) external view returns (uint256 n) {
        uint256 len = _allTokens.length;
        for (uint256 i; i < len; ++i) {
            uint256 id = _allTokens[i];
            if (_ownerOf[id] == owner && _info[id].drawingId == drawingId) ++n;
        }
    }

    /*//////////////////////////////////////////////////////////////
                             JACKPOT-ONLY
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint a ticket. **No receiver hook** — see the contract-level note.
    function mintTicket(address to, uint256 tokenId, uint256 drawingId, uint256 packedTicket) external {
        if (msg.sender != jackpot) revert NotJackpot();
        if (_ownerOf[tokenId] != address(0)) revert TokenAlreadyExists();
        _ownerOf[tokenId] = to;
        _info[tokenId] = TrackedTicket({drawingId: drawingId, packedTicket: packedTicket, referralScheme: bytes32(0)});
        _allTokens.push(tokenId);
        emit Transfer(address(0), to, tokenId);
    }

    /// @notice Burn a claimed ticket. Ticket info is retained, matching the real contract;
    ///         only ownership is cleared, so `ownerOf` starts reverting.
    function burnTicket(uint256 tokenId) external {
        if (msg.sender != jackpot) revert NotJackpot();
        address owner = _ownerOf[tokenId];
        if (owner == address(0)) revert TokenDoesNotExist();
        delete _ownerOf[tokenId];
        emit Transfer(owner, address(0), tokenId);
    }

    /*//////////////////////////////////////////////////////////////
                               TRANSFERS
    //////////////////////////////////////////////////////////////*/

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    /// @notice Plain transfer. Cannot be prevented by a recipient, so this is the path that
    ///         strands an NFT in the pool: invisible to `ticketIds`, unclaimable, and by
    ///         design not rescuable. It must corrupt no accounting.
    function transferFrom(address from, address to, uint256 tokenId) public {
        if (_ownerOf[tokenId] != from) revert NotAuthorized();
        if (msg.sender != from && !isApprovedForAll[from][msg.sender]) revert NotAuthorized();
        _ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    /// @notice Safe transfer — fires the receiver hook, so it reverts into a contract that
    ///         does not implement one. FarpotPool deliberately does not.
    function safeTransferFrom(address from, address to, uint256 tokenId) public {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0) {
            (bool ok, bytes memory ret) = to.call(
                abi.encodeWithSignature(
                    "onERC721Received(address,address,uint256,bytes)", msg.sender, from, tokenId, ""
                )
            );
            if (!ok || ret.length != 32 || abi.decode(ret, (bytes4)) != 0x150b7a02) {
                revert TransferToNonERC721ReceiverImplementer();
            }
        }
    }
}

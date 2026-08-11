// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {FarpotPool} from "../src/FarpotPool.sol";
import {IFarpotPool} from "../src/interfaces/IFarpotPool.sol";
import {MockJackpot} from "./mocks/MockJackpot.sol";
import {MockRandomTicketBuyer} from "./mocks/MockRandomTicketBuyer.sol";
import {MockTicketNFT} from "./mocks/MockTicketNFT.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Shared wiring for every FarpotPool test: the four mocks, a deployed pool, and
///         three funded contributors.
/// @dev The mock graph is circular (the Jackpot names the NFT, the NFT names the Jackpot),
///      so the Jackpot is built with a zero NFT and back-wired — the same shape the real
///      deployment has, and the reason the constructor's five cross-checks exist at all.
abstract contract PoolTestBase is Test {
    MockUSDC internal usdc;
    MockTicketNFT internal nft;
    MockJackpot internal jackpot;
    MockRandomTicketBuyer internal rtb;
    FarpotPool internal pool;

    address internal constant REFERRAL = address(0xBEEF);
    address internal alice;
    address internal bob;
    address internal carol;
    address internal outsider;

    /// @dev A non-round starting drawing, so nothing can accidentally pass by matching 0/1.
    uint256 internal constant D0 = 129;
    uint256 internal constant PRICE = 1e6;

    /// @dev `stringToHex("farpot-pool", { size: 32 })` — must match FarpotPool's own.
    bytes32 internal constant SOURCE = 0x666172706f742d706f6f6c000000000000000000000000000000000000000000;

    function setUp() public virtual {
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
        outsider = makeAddr("outsider");

        usdc = new MockUSDC();
        jackpot = new MockJackpot(address(0), address(usdc), D0);
        nft = new MockTicketNFT(address(jackpot));
        jackpot.setJackpotNFT(address(nft));
        rtb = new MockRandomTicketBuyer(address(jackpot), address(usdc));
        jackpot.setAuthorizedMinter(address(rtb), true);

        pool = new FarpotPool(address(jackpot), address(rtb), address(nft), address(usdc), REFERRAL);

        _fund(alice);
        _fund(bob);
        _fund(carol);

        // The Jackpot pays winnings out of its own balance; seed it so a win is payable.
        usdc.mint(address(jackpot), 1_000_000e6);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _fund(address who) internal {
        usdc.mint(who, 10_000e6);
        vm.prank(who);
        usdc.approve(address(pool), type(uint256).max);
    }

    function _join(address who, uint32 n) internal {
        vm.prank(who);
        pool.join(n);
    }

    /// @notice Settle the current drawing and roll over — atomic upstream, one write here.
    function _rollover() internal {
        jackpot.setCurrentDrawingId(jackpot.currentDrawingId() + 1);
    }

    function _cap() internal view returns (uint32) {
        return uint32(pool.MAX_TICKETS_PER_JOIN());
    }

    /// @notice Live (unburned) tickets the pool holds for `d`.
    /// @dev Enumerated from the NFT rather than from the pool's internal `ticketIds` array,
    ///      so assertions describe observable behaviour instead of a storage layout.
    function _poolOwnedTickets(uint256 d) internal view returns (uint256) {
        return nft.balanceOfDrawing(address(pool), d);
    }

    /// @notice Mark `n` of the pool's tickets for drawing `d` as winners worth `each`.
    /// @dev Returns the total staked so a test can assert the pot against it exactly.
    function _makeWinners(uint256 d, uint256 n, uint256 each) internal returns (uint256 total) {
        uint256 len = nft.allTokensLength();
        uint256 marked;
        for (uint256 i; i < len && marked < n; ++i) {
            uint256 id = nft.tokenAt(i);
            if (nft.getTicketInfo(id).drawingId != d) continue;
            if (nft.ownerOf(id) != address(pool)) continue;
            jackpot.setWinnings(id, each);
            total += each;
            ++marked;
        }
        assertEq(marked, n, "_makeWinners: not enough pool tickets in that drawing");
    }

    /// @notice Drain a drawing's cursor completely, in `MAX_CLAIM_BATCH`-sized bites.
    function _drainCursor(uint256 d) internal {
        uint16 batch = uint16(pool.MAX_CLAIM_BATCH());
        while (true) {
            (,,,, uint256 cursor, uint256 count) = pool.poolOf(d);
            if (cursor >= count) break;
            pool.claimBatch(d, batch);
        }
    }
}

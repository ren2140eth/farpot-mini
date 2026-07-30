// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {MockJackpot} from "./mocks/MockJackpot.sol";
import {MockRandomTicketBuyer} from "./mocks/MockRandomTicketBuyer.sol";
import {MockTicketNFT} from "./mocks/MockTicketNFT.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Records whether it was ever handed a token through the ERC-721 receiver hook.
contract RecordingReceiver {
    bool public received;

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        received = true;
        return this.onERC721Received.selector;
    }
}

/// @notice Implements no receiver hook — stands in for FarpotPool, which deliberately does
///         not implement one either.
contract NonReceiver {}

/// @notice Smoke tests for the Phase 2 mocks themselves.
/// @dev These assert nothing about FarpotPool — it does not exist yet. They exist because
///      the mocks are the instrument the whole Phase 3 suite is measured with, and this
///      project's standing rule is that compiling proves nothing. A mock that compiles but
///      injects the wrong misbehaviour would make Phase 3 tests pass for the wrong reason,
///      which is exactly the failure class the plan is built to avoid.
contract MocksTest is Test {
    MockUSDC internal usdc;
    MockTicketNFT internal nft;
    MockJackpot internal jackpot;
    MockRandomTicketBuyer internal rtb;

    address internal constant REFERRAL = address(0xBEEF);
    address internal outsider;

    uint256 internal constant D0 = 129;
    uint256 internal constant PRICE = 1e6;

    function setUp() public {
        outsider = makeAddr("outsider");
        usdc = new MockUSDC();
        // The NFT and Jackpot reference each other, so one is wired after construction.
        jackpot = new MockJackpot(address(0), address(usdc), D0);
        nft = new MockTicketNFT(address(jackpot));
        jackpot.setJackpotNFT(address(nft));
        rtb = new MockRandomTicketBuyer(address(jackpot), address(usdc));
        jackpot.setAuthorizedMinter(address(rtb), true);
        jackpot.setAuthorizedMinter(address(this), true);

        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(rtb), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                          HONEST BEHAVIOUR
    //////////////////////////////////////////////////////////////*/

    function test_honest_buy_mints_to_recipient_in_current_drawing() public {
        uint256[] memory ids = _buy(5, address(this));

        assertEq(ids.length, 5, "id count");
        for (uint256 i; i < ids.length; ++i) {
            assertEq(nft.ownerOf(ids[i]), address(this), "owner");
            assertEq(nft.getTicketInfo(ids[i]).drawingId, D0, "drawing");
            for (uint256 k; k < i; ++k) {
                assertTrue(ids[i] != ids[k], "ids must be unique");
            }
        }
        assertEq(rtb.lastRecipient(), address(this), "recipient captured");
        assertEq(rtb.lastCount(), 5, "count captured");
    }

    /// @dev The referral wallet reaching `_referrers[0]` is the revenue path; the mock must
    ///      capture it faithfully or Phase 3 cannot assert on it.
    function test_honest_buy_captures_referral_args() public {
        _buy(1, address(this));

        address[] memory refs = rtb.getLastReferrers();
        uint256[] memory split = rtb.getLastReferralSplit();
        assertEq(refs.length, 1, "one referrer");
        assertEq(refs[0], REFERRAL, "referral wallet");
        assertEq(split.length, 1, "one split");
        assertEq(split[0], 1e18, "100% split");
        assertEq(rtb.lastSource(), bytes32("farpot-pool"), "source");
    }

    /// @dev Pulling the EXACT cost is what leaves a zero allowance behind — the property
    ///      FarpotPool asserts with `AllowanceResidue`.
    function test_honest_buy_consumes_exactly_the_allowance() public {
        usdc.approve(address(rtb), 3 * PRICE);
        _buy(3, address(this));
        assertEq(usdc.allowance(address(this), address(rtb)), 0, "allowance fully consumed");
    }

    function test_ticket_ids_are_not_monotonic() public {
        uint256[] memory ids = _buy(10, address(this));
        bool sawDecrease;
        for (uint256 i = 1; i < ids.length; ++i) {
            if (ids[i] < ids[i - 1]) sawDecrease = true;
        }
        // Ordering-based validation would revert on real buys (design §2.7); the mock must
        // reproduce that hazard rather than hand out conveniently increasing ids.
        assertTrue(sawDecrease, "keccak ids must not be monotonically increasing");
    }

    /*//////////////////////////////////////////////////////////////
                       INJECTABLE MISBEHAVIOUR
    //////////////////////////////////////////////////////////////*/

    function test_mode_duplicateInResponse() public {
        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.DuplicateInResponse);
        uint256[] memory ids = _buy(4, address(this));
        assertEq(ids.length, 4, "length still correct");
        assertEq(ids[3], ids[0], "last id duplicates the first");
    }

    function test_mode_foreignOwner_at_configured_index() public {
        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.ForeignOwner);
        rtb.setForeignOwner(outsider);
        rtb.setForeignIndex(2);

        uint256[] memory ids = _buy(4, address(this));
        assertEq(nft.ownerOf(ids[0]), address(this), "index 0 ours");
        assertEq(nft.ownerOf(ids[1]), address(this), "index 1 ours");
        assertEq(nft.ownerOf(ids[2]), outsider, "index 2 foreign");
        assertEq(nft.ownerOf(ids[3]), address(this), "index 3 ours");
    }

    function test_mode_shortArray_and_longArray() public {
        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.ShortArray);
        assertEq(_buy(5, address(this)).length, 4, "short");

        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.LongArray);
        assertEq(_buy(5, address(this)).length, 6, "long");
    }

    function test_mode_mixedDrawing() public {
        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.MixedDrawing);
        uint256[] memory ids = _buy(3, address(this));
        assertEq(nft.getTicketInfo(ids[0]).drawingId, D0, "first in current drawing");
        assertEq(nft.getTicketInfo(ids[1]).drawingId, D0 + 1, "second in the next");
        assertEq(nft.getTicketInfo(ids[2]).drawingId, D0 + 1, "third in the next");
    }

    function test_mode_replayIds_returns_the_set_verbatim() public {
        uint256[] memory first = _buy(2, address(this));

        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.ReplayIds);
        rtb.setReplayIds(first);
        uint256[] memory replayed = _buy(2, address(this));

        assertEq(replayed.length, 2, "length");
        assertEq(replayed[0], first[0], "id 0 replayed");
        assertEq(replayed[1], first[1], "id 1 replayed");
        // Still ours, so a pool would reach its duplicate check rather than an owner check.
        assertEq(nft.ownerOf(replayed[0]), address(this), "still owned");
    }

    function test_mode_allowanceResidue_leaves_one_unit() public {
        usdc.approve(address(rtb), 3 * PRICE);
        rtb.setMode(MockRandomTicketBuyer.Misbehaviour.AllowanceResidue);
        _buy(3, address(this));
        assertEq(usdc.allowance(address(this), address(rtb)), 1, "one unit of residue");
    }

    /*//////////////////////////////////////////////////////////////
                        THE HOOK PROPERTIES
    //////////////////////////////////////////////////////////////*/

    /// @dev The single most load-bearing property of the NFT mock. Megapot mints with solady
    ///      `_mint`, so a contract recipient receives NO callback — which is why enumeration
    ///      must come from the buy return value. An earlier design made that hook the sole
    ///      enumeration mechanism and would have silently recorded zero tickets forever.
    function test_mint_does_NOT_invoke_the_receiver_hook() public {
        RecordingReceiver r = new RecordingReceiver();
        _buy(1, address(r));
        assertFalse(r.received(), "minting must never fire onERC721Received");
    }

    function test_safeTransferFrom_DOES_invoke_the_receiver_hook() public {
        RecordingReceiver r = new RecordingReceiver();
        uint256[] memory ids = _buy(1, address(this));
        nft.safeTransferFrom(address(this), address(r), ids[0]);
        assertTrue(r.received(), "safe transfer must fire the hook");
        assertEq(nft.ownerOf(ids[0]), address(r), "ownership moved");
    }

    /// @dev This is what makes a stray safe-transfer into FarpotPool revert.
    function test_safeTransferFrom_reverts_into_a_contract_without_a_hook() public {
        NonReceiver n = new NonReceiver();
        uint256[] memory ids = _buy(1, address(this));
        vm.expectRevert(MockTicketNFT.TransferToNonERC721ReceiverImplementer.selector);
        nft.safeTransferFrom(address(this), address(n), ids[0]);
    }

    /// @dev A plain transfer cannot be prevented, so it strands the token. No accounting is
    ///      corrupted — the pool simply never learns of it.
    function test_plain_transferFrom_into_a_non_receiver_succeeds() public {
        NonReceiver n = new NonReceiver();
        uint256[] memory ids = _buy(1, address(this));
        nft.transferFrom(address(this), address(n), ids[0]);
        assertEq(nft.ownerOf(ids[0]), address(n), "stranded, not reverted");
    }

    /*//////////////////////////////////////////////////////////////
                              CLAIMING
    //////////////////////////////////////////////////////////////*/

    function test_claim_pays_winners_tolerates_losers_and_burns_both() public {
        uint256[] memory ids = _buy(2, address(this));
        jackpot.setWinnings(ids[0], 7e6); // winner
        // ids[1] left unset — a loser, the common case.
        usdc.mint(address(jackpot), 100e6);
        jackpot.setCurrentDrawingId(D0 + 1); // settle + roll over, atomically

        uint256 before = usdc.balanceOf(address(this));
        jackpot.claimWinnings(ids);

        assertEq(usdc.balanceOf(address(this)) - before, 7e6, "winner paid, loser harmless");
        vm.expectRevert(MockTicketNFT.TokenDoesNotExist.selector);
        nft.ownerOf(ids[0]);
        vm.expectRevert(MockTicketNFT.TokenDoesNotExist.selector);
        nft.ownerOf(ids[1]);
    }

    /// @dev The one hard rule: never re-submit a claimed ticket. This is why the pool's
    ///      cursor must never re-cover a slice it has already claimed.
    function test_claim_reverts_on_an_already_claimed_ticket() public {
        uint256[] memory ids = _buy(1, address(this));
        jackpot.setCurrentDrawingId(D0 + 1);
        jackpot.claimWinnings(ids);

        vm.expectRevert(MockTicketNFT.TokenDoesNotExist.selector);
        jackpot.claimWinnings(ids);
    }

    function test_claim_reverts_for_an_unsettled_drawing() public {
        uint256[] memory ids = _buy(1, address(this));
        // Still the current drawing — never rolled over.
        vm.expectRevert(MockJackpot.TicketFromFutureDrawing.selector);
        jackpot.claimWinnings(ids);
    }

    function test_claim_spans_two_settled_drawings() public {
        uint256[] memory a = _buy(1, address(this));
        jackpot.setCurrentDrawingId(D0 + 1);
        uint256[] memory b = _buy(1, address(this));
        jackpot.setCurrentDrawingId(D0 + 2);

        jackpot.setWinnings(a[0], 2e6);
        jackpot.setWinnings(b[0], 3e6);
        usdc.mint(address(jackpot), 100e6);

        uint256[] memory both = new uint256[](2);
        both[0] = a[0];
        both[1] = b[0];

        uint256 before = usdc.balanceOf(address(this));
        jackpot.claimWinnings(both);
        assertEq(usdc.balanceOf(address(this)) - before, 5e6, "both drawings paid");
    }

    /*//////////////////////////////////////////////////////////////
                      ROLLOVER & DEPENDENCY WIRING
    //////////////////////////////////////////////////////////////*/

    /// @dev Rollover with NO pool transaction in between is the exact case a stored
    ///      lifecycle got wrong, so the mock must support it as a single write.
    function test_currentDrawingId_is_mutable_and_carries_price_forward() public {
        assertEq(jackpot.currentDrawingId(), D0);
        jackpot.setCurrentDrawingId(D0 + 1);
        assertEq(jackpot.currentDrawingId(), D0 + 1, "rolled over");
        assertEq(jackpot.getDrawingState(D0 + 1).ticketPrice, PRICE, "price carried forward");
    }

    function test_jackpotLock_is_settable_per_drawing() public {
        assertFalse(jackpot.getDrawingState(D0).jackpotLock, "unlocked by default");
        jackpot.setJackpotLock(D0, true);
        assertTrue(jackpot.getDrawingState(D0).jackpotLock, "locked");
    }

    /// @dev The five constructor cross-checks need each getter to be independently
    ///      falsifiable, or the negative constructor tests cannot be written.
    function test_dependency_getters_are_settable_for_inconsistent_graph_tests() public {
        assertEq(jackpot.jackpotNFT(), address(nft));
        assertEq(jackpot.usdc(), address(usdc));
        assertEq(rtb.jackpot(), address(jackpot));
        assertEq(rtb.usdc(), address(usdc));
        assertEq(nft.jackpot(), address(jackpot));

        jackpot.setJackpotNFT(outsider);
        rtb.setUsdc(outsider);
        nft.setJackpot(outsider);
        assertEq(jackpot.jackpotNFT(), outsider);
        assertEq(rtb.usdc(), outsider);
        assertEq(nft.jackpot(), outsider);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPER
    //////////////////////////////////////////////////////////////*/

    function _buy(uint256 count, address recipient) internal returns (uint256[] memory) {
        address[] memory referrers = new address[](1);
        referrers[0] = REFERRAL;
        uint256[] memory split = new uint256[](1);
        split[0] = 1e18;
        return rtb.buyTickets(count, recipient, referrers, split, bytes32("farpot-pool"));
    }
}

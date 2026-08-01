// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {FarpotPool} from "../src/FarpotPool.sol";
import {MegapotAddresses} from "../src/MegapotAddresses.sol";
import {IFarpotPool} from "../src/interfaces/IFarpotPool.sol";

/// @notice Deploys `FarpotPool` to Base, refusing to broadcast unless every input matches the
///         project's declared source of truth and the signer is the intended owner.
///
/// @dev Two properties this script exists to guarantee, both of which fail SILENTLY without it:
///
///      1. **The addresses.** `src/lib/constants.ts` is the source of truth and Solidity cannot
///         import TypeScript, so the env values are checked against `MegapotAddresses`, and
///         `npm run check:addresses` separately proves `MegapotAddresses` still agrees with
///         `constants.ts`. That is the full chain: env → MegapotAddresses → constants.ts. A pool
///         deployed against a wrong-but-consistent address graph would pass the constructor's own
///         cross-checks quite happily.
///
///      2. **The owner.** `FarpotPool`'s constructor calls `_initializeOwner(msg.sender)`, so the
///         owner IS the signer — it is not a constructor argument and cannot be corrected by
///         passing a different value. Signing from the wrong wallet produces a pool whose only
///         admin power belongs to the wrong key, and the only fix is a second transaction
///         (`transferOwnership`) or a redeploy. So the signer is asserted against `POOL_OWNER`
///         BEFORE anything is broadcast, where a revert costs nothing.
///
///      The `referralWallet` check is the one that matters most commercially: it is the revenue
///      path, a wrong value is invisible in every functional test, and the Phase 6 encode proof
///      cannot catch it because the referral wallet is a constructor argument that the proof
///      models rather than reads.
///
///      Usage (Base mainnet), signing however you prefer — keystore account shown:
///
///          POOL_OWNER=0x… forge script script/DeployFarpotPool.s.sol \
///            --rpc-url "$BASE_RPC_URL" --account <keystore-name> --broadcast \
///            --verify --verifier sourcify
///
///      Drop `--broadcast` for a dry run; the assertions all still execute.
contract DeployFarpotPool is Script {
    uint256 internal constant BASE_CHAIN_ID = 8453;

    function run() external returns (FarpotPool pool) {
        // The intended owner. Required rather than defaulted: defaulting to the signer would
        // make this check tautological and silently accept whichever key happened to be loaded.
        address expectedOwner = vm.envAddress("POOL_OWNER");
        require(expectedOwner != address(0), "POOL_OWNER is the zero address");

        // Optional overrides so the script is testable against mocks on a fork. Unset (the
        // production path) means "use the canonical Base address", which is what gets checked.
        address jackpot = vm.envOr("MEGAPOT_JACKPOT", MegapotAddresses.JACKPOT);
        address rtb = vm.envOr("MEGAPOT_RANDOM_TICKET_BUYER", MegapotAddresses.RANDOM_TICKET_BUYER);
        address nft = vm.envOr("MEGAPOT_TICKET_NFT", MegapotAddresses.TICKET_NFT);
        address usdc = vm.envOr("MEGAPOT_USDC", MegapotAddresses.USDC);
        address referral = vm.envOr("FARPOT_REFERRAL_WALLET", MegapotAddresses.REFERRAL_WALLET);

        // On Base these MUST be the canonical values. A fork run against mocks is allowed to
        // differ, which is why the guard is chain-scoped rather than unconditional.
        if (block.chainid == BASE_CHAIN_ID) {
            require(jackpot == MegapotAddresses.JACKPOT, "jackpot != constants.ts");
            require(rtb == MegapotAddresses.RANDOM_TICKET_BUYER, "randomTicketBuyer != constants.ts");
            require(nft == MegapotAddresses.TICKET_NFT, "ticketNft != constants.ts");
            require(usdc == MegapotAddresses.USDC, "usdc != constants.ts");
            require(referral == MegapotAddresses.REFERRAL_WALLET, "referralWallet != constants.ts");
        }

        vm.startBroadcast();

        // Assert the signer BEFORE deploying. `readCallers` reports the broadcasting sender, so
        // a mismatch reverts while the only cost is a wasted simulation.
        (VmSafe.CallerMode mode, address signer,) = vm.readCallers();
        require(mode == VmSafe.CallerMode.Broadcast || mode == VmSafe.CallerMode.RecurrentBroadcast, "not broadcasting");
        require(
            signer == expectedOwner,
            "signer is not POOL_OWNER - the owner is the deployer and cannot be set any other way"
        );

        pool = new FarpotPool(jackpot, rtb, nft, usdc, referral);

        vm.stopBroadcast();

        // Post-deploy verification against the DEPLOYED contract, not the script's intent. The
        // constructor could in principle assign an immutable from the wrong parameter; only
        // reading it back rules that out.
        require(address(pool.jackpot()) == jackpot, "deployed jackpot mismatch");
        require(address(pool.randomTicketBuyer()) == rtb, "deployed randomTicketBuyer mismatch");
        require(address(pool.ticketNft()) == nft, "deployed ticketNft mismatch");
        require(pool.usdc() == usdc, "deployed usdc mismatch");
        require(pool.referralWallet() == referral, "deployed referralWallet mismatch - REVENUE PATH");
        require(pool.owner() == expectedOwner, "deployed owner mismatch");
        require(!pool.paused(), "deployed paused");

        // An empty pool for the live drawing must be Accumulating (1) — the lifecycle is derived,
        // so this also proves the dependency graph reads cleanly from the deployed address.
        uint256 drawingId = pool.jackpot().currentDrawingId();
        require(pool.poolStateOf(drawingId) == IFarpotPool.PoolState.Accumulating, "state != Accumulating");
        (uint256 tickets, uint256 contributors,,,,) = pool.poolOf(drawingId);
        require(tickets == 0 && contributors == 0, "fresh pool is not empty");

        console2.log("FarpotPool          ", address(pool));
        console2.log("deployment block    ", block.number);
        console2.log("chain id            ", block.chainid);
        console2.log("owner               ", pool.owner());
        console2.log("referralWallet      ", pool.referralWallet());
        console2.log("jackpot             ", address(pool.jackpot()));
        console2.log("randomTicketBuyer   ", address(pool.randomTicketBuyer()));
        console2.log("ticketNft           ", address(pool.ticketNft()));
        console2.log("usdc                ", pool.usdc());
        console2.log("currentDrawingId    ", drawingId);
        console2.log("MAX_TICKETS_PER_JOIN", pool.MAX_TICKETS_PER_JOIN());
        console2.log("--- record FARPOT_POOL_ADDRESS and the deployment block in constants.ts ---");
    }
}

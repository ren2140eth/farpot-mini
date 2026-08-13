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
///         owner is initially the SIGNER — it is not a constructor argument. `POOL_OWNER` names
///         the address that must own the pool when this script finishes, and the script closes
///         the gap itself: if the signer is not already that address, it calls
///         `transferOwnership` inside the SAME broadcast. That supports deploying from a
///         throwaway key while a long-lived wallet (or, later, a multisig) ends up owning the
///         pool, without leaving a window in which the throwaway holds the pause power.
///
///         The invariant asserted at the end is the one that actually matters —
///         `pool.owner() == POOL_OWNER` — rather than a proxy for it.
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
        // The address that must own the pool when this script finishes. Required rather than
        // defaulted: defaulting to the signer would make the check tautological and silently
        // accept whichever key happened to be loaded.
        address expectedOwner = vm.envAddress("POOL_OWNER");
        require(expectedOwner != address(0), "POOL_OWNER is the zero address");

        // Typo guard. Ownership is one-way — transferring to a mistyped address hands the pause
        // power to nobody, permanently, and no other assertion here would notice because a typo
        // is a perfectly valid address. A real wallet has sent a transaction or has code; a
        // fat-fingered one almost never does. Override deliberately for a brand-new wallet.
        if (vm.getNonce(expectedOwner) == 0 && expectedOwner.code.length == 0) {
            require(
                vm.envOr("ALLOW_FRESH_OWNER", false),
                "POOL_OWNER has no nonce and no code - looks like a typo. Set ALLOW_FRESH_OWNER=true if deliberate"
            );
        }

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

        (VmSafe.CallerMode mode, address signer,) = vm.readCallers();
        require(mode == VmSafe.CallerMode.Broadcast || mode == VmSafe.CallerMode.RecurrentBroadcast, "not broadcasting");

        pool = new FarpotPool(jackpot, rtb, nft, usdc, referral);

        // The constructor made the SIGNER the owner. Hand it to the intended owner in the same
        // broadcast, so a throwaway deployer never holds the pause power for longer than this run.
        if (signer != expectedOwner) {
            pool.transferOwnership(expectedOwner);
        }

        vm.stopBroadcast();

        // Post-deploy verification against the DEPLOYED contract, not the script's intent. The
        // constructor could in principle assign an immutable from the wrong parameter; only
        // reading it back rules that out.
        require(address(pool.jackpot()) == jackpot, "deployed jackpot mismatch");
        require(address(pool.randomTicketBuyer()) == rtb, "deployed randomTicketBuyer mismatch");
        require(address(pool.ticketNft()) == nft, "deployed ticketNft mismatch");
        require(pool.usdc() == usdc, "deployed usdc mismatch");
        require(pool.referralWallet() == referral, "deployed referralWallet mismatch - REVENUE PATH");
        // The invariant that matters: whoever signed, the pool ends up owned by POOL_OWNER.
        require(pool.owner() == expectedOwner, "deployed owner mismatch");
        require(pool.paused(), "deployed unpaused - migration race window is open");

        // An empty pool for the live drawing must be Accumulating (1) — the lifecycle is derived,
        // so this also proves the dependency graph reads cleanly from the deployed address.
        uint256 drawingId = pool.jackpot().currentDrawingId();
        require(pool.poolStateOf(drawingId) == IFarpotPool.PoolState.Accumulating, "state != Accumulating");
        (uint256 tickets, uint256 contributors,,,,) = pool.poolOf(drawingId);
        require(tickets == 0 && contributors == 0, "fresh pool is not empty");

        console2.log("FarpotPool          ", address(pool));
        // NOT the deployment block. During a broadcast this is the block the SIMULATION ran
        // against, and the transaction lands a few blocks later — the real deploy logged
        // 49497965 here and mined in 49497969. Take the deployment block from the receipt
        // (`cast receipt <hash>`) or from broadcast/…/run-latest.json, never from this line.
        console2.log("simulated at block  ", block.number);
        console2.log("chain id            ", block.chainid);
        console2.log("owner               ", pool.owner());
        console2.log("signer (deployer)   ", signer);
        console2.log("ownership transfer  ", signer == expectedOwner ? "not needed" : "DONE in this run");
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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The live Megapot addresses on Base, in ONE place for Solidity.
/// @dev `src/lib/constants.ts` is the project's declared source of truth, and Solidity cannot
///      import from TypeScript. Rather than let each test file carry its own copy and drift
///      silently, every Solidity consumer reads these — and `npm run check:addresses` parses
///      both files and fails if any value disagrees. That check is the thing that makes this
///      file safe; without it this is just a second source of truth wearing a hat.
library MegapotAddresses {
    address internal constant JACKPOT = 0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2;
    address internal constant RANDOM_TICKET_BUYER = 0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd;
    address internal constant TICKET_NFT = 0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant REFERRAL_WALLET = 0xeEeC2d83DA24512D37410F7cA5B18FD805fB79d2;
}

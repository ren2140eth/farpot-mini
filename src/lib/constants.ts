// Megapot v2 Contract Addresses (Base mainnet)
// Source: https://docs.megapot.io/developers/contract-overview

export const JACKPOT_ADDRESS = "0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2" as const;
export const RANDOM_TICKET_BUYER_ADDRESS = "0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd" as const;
export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const PAYOUT_CALCULATOR_ADDRESS = "0x97a22361b6208aC8cd9afaea09D20feC47046CBD" as const;

// JackpotTicketNFT — the ERC-721 Megapot mints tickets as. Verified on-chain:
// `Jackpot.jackpotNFT()` returns this, and it is assigned only inside the one-shot
// `initialize()` which the live Jackpot has already consumed, so it cannot be swapped.
// Needed by FarpotPool, which reads `ownerOf` / `getTicketInfo` on every pooled ticket.
export const JACKPOT_TICKET_NFT_ADDRESS = "0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4" as const;

// Referral wallet — earns the referral fee on every ticket sale.
// Passed as the `_referrers[0]` arg on each buy; fees are claimed with
// `claimReferralFees()`.
export const REFERRAL_WALLET = "0xeEeC2d83DA24512D37410F7cA5B18FD805fB79d2" as const;

// FarpotPool — the group-buy pool contract (contracts/src/FarpotPool.sol).
// Deployed to Base 2026-08-13, source-verified on Sourcify with an EXACT match
// (creation and runtime): https://repo.sourcify.dev/8453/0xfBE555a34066E10464f28ce9b46D862aD8031906
// The owner's only power is pause()/unpause(), which blocks
// join() alone — claimBatch() and claim() keep working while paused, so pausing can never
// strand funds. All five constructor dependencies were read back off-chain and match the
// addresses above.
//
// This REPLACES 0x0F28287571E0e81a4352594B6D2e46761A88D320, which had no sponsor surface
// (`sponsorsOf` and `sponsorShareOf` revert on it). The old pool was drained and retired
// first: drawings 141 and 142 both Settled with the claim cursor fully advanced, every
// entitlement at zero, and only one atomic unit of `fullMulDiv` rounding dust left behind.
//
// Moving this address REQUIRES bumping `V` in pool-cache.ts in the SAME push. The cache keys
// are namespaced by V, not by address, so a repoint without a bump would serve the old pool's
// cached contributor lists under the new contract. It also resets the contributors route's
// cold-rebuild window, which is measured from FARPOT_POOL_DEPLOY_BLOCK below.
export const FARPOT_POOL_ADDRESS = "0xfBE555a34066E10464f28ce9b46D862aD8031906" as const;

// The block FarpotPool was deployed in, taken from the transaction receipt
// (0xb52ec27c…6f71d). This is the cold-cache `fromBlock` for any Joined-log scan — never
// use 0, which would scan the whole chain.
//
// Do NOT take this from the deploy script's console output: that line prints the block the
// SIMULATION ran against (it said 49927142), while the transaction actually mined in 49927357.
// The same trap caught the previous deploy, which simulated at 49497965 and mined in 49497969.
// `BigInt(…)` rather than a `49927357n` literal: tsconfig targets ES2017, which rejects
// BigInt literal syntax outright ("BigInt literals are not available when targeting lower
// than ES2020"). The value is a bigint either way, which is what viem's `fromBlock` wants.
export const FARPOT_POOL_DEPLOY_BLOCK = BigInt(49927357);

// FarpotPool ABI — only what the app actually calls, transcribed from
// contracts/src/interfaces/IFarpotPool.sol (the compiler-enforced surface).
//
// The custom errors are included deliberately even though the app never calls them: viem
// decodes a revert against the ABI, so without them a failed join surfaces as raw bytes and
// the UI cannot tell "the draw is about to happen, try again shortly" (PoolLocked, clears by
// itself) from "joining is paused" (Paused, clears only when the owner unpauses).
export const FARPOT_POOL_ABI = [
  // --- constants ---
  {
    inputs: [],
    name: "MAX_TICKETS_PER_JOIN",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // The contract's own ceiling on a claimBatch slice. The cron reads it rather than
  // hardcoding 75: winner and loser tickets cost different gas, so the batch size the cron
  // actually uses is adaptive, and the only fixed number in play must come from the chain.
  {
    inputs: [],
    name: "MAX_CLAIM_BATCH",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "paused",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  // --- mutative ---
  {
    inputs: [{ internalType: "uint32", name: "tickets", type: "uint32" }],
    name: "join",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256[]", name: "drawingIds", type: "uint256[]" }],
    name: "claim",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Buys tickets the pool owns and claims itself — credited to sponsoredByUser/totalSponsored/
  // sponsorCount, NEVER to totalTickets. Sponsors take no payout weight; see sponsorShareOf.
  {
    inputs: [{ internalType: "uint32", name: "tickets", type: "uint32" }],
    name: "sponsor",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Permissionless and NOT pausable. The app never calls this — the cron does (Phase 9) —
  // but it lives here because constants.ts is the single source of truth for the ABI and a
  // second transcription elsewhere is exactly how an ABI drifts from its contract.
  {
    inputs: [
      { internalType: "uint256", name: "drawingId", type: "uint256" },
      { internalType: "uint16", name: "count", type: "uint16" },
    ],
    name: "claimBatch",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // --- views ---
  // poolState is the derived lifecycle: None=0, Accumulating=1, Claimable=2, Settled=3.
  {
    inputs: [{ internalType: "uint256", name: "drawingId", type: "uint256" }],
    name: "poolOf",
    outputs: [
      { internalType: "uint256", name: "tickets", type: "uint256" },
      { internalType: "uint256", name: "contributors", type: "uint256" },
      { internalType: "uint256", name: "potAmount", type: "uint256" },
      { internalType: "uint8", name: "poolState", type: "uint8" },
      { internalType: "uint256", name: "cursor", type: "uint256" },
      { internalType: "uint256", name: "ticketCount", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  // `owed` is ONLY a final figure once poolState === Settled. While Claimable it reflects the
  // pot collected so far, so the UI must not show it as a payout — see POOL_STATE below.
  {
    inputs: [
      { internalType: "uint256", name: "drawingId", type: "uint256" },
      { internalType: "address", name: "who", type: "address" },
    ],
    name: "shareOf",
    outputs: [
      { internalType: "uint256", name: "tickets", type: "uint256" },
      { internalType: "uint256", name: "owed", type: "uint256" },
      { internalType: "bool", name: "hasClaimed", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "drawingId", type: "uint256" }],
    name: "poolStateOf",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "drawingId", type: "uint256" },
      { internalType: "address", name: "who", type: "address" },
    ],
    name: "sponsoredByUser",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "drawingId", type: "uint256" }],
    name: "sponsorsOf",
    outputs: [
      { internalType: "uint256", name: "tickets", type: "uint256" },
      { internalType: "uint256", name: "sponsors", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  // `owed` is non-zero ONLY when totalTickets[drawingId] === 0 — the zero-joiner fallback that
  // pays sponsors instead. hasClaimed is shared with shareOf's claimant class.
  {
    inputs: [
      { internalType: "uint256", name: "drawingId", type: "uint256" },
      { internalType: "address", name: "who", type: "address" },
    ],
    name: "sponsorShareOf",
    outputs: [
      { internalType: "uint256", name: "tickets", type: "uint256" },
      { internalType: "uint256", name: "owed", type: "uint256" },
      { internalType: "bool", name: "hasClaimed", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  // --- events ---
  // Both drawingId and contributor are indexed, so the contributor route filters the current
  // drawing by topic instead of scanning history.
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "drawingId", type: "uint256" },
      { indexed: true, internalType: "address", name: "contributor", type: "address" },
      { indexed: false, internalType: "uint256", name: "tickets", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "mintedCount", type: "uint256" },
    ],
    name: "Joined",
    type: "event",
  },
  // How the cron reports what a crank actually collected. `potDelta` is the MEASURED USDC
  // delta for that slice, not a balance read, so it is the only trustworthy figure to log.
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "drawingId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "count", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "potDelta", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "cursor", type: "uint256" },
    ],
    name: "BatchClaimed",
    type: "event",
  },
  // A sponsor bought tickets FOR the pool, taking no payout weight for them.
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "drawingId", type: "uint256" },
      { indexed: true, internalType: "address", name: "sponsor", type: "address" },
      { indexed: false, internalType: "uint256", name: "tickets", type: "uint256" },
    ],
    name: "Sponsored",
    type: "event",
  },
  // --- errors (for decoding reverts into friendly copy) ---
  { inputs: [], name: "InvalidTicketCount", type: "error" },
  { inputs: [], name: "PoolLocked", type: "error" },
  { inputs: [], name: "Paused", type: "error" },
  { inputs: [], name: "MintCountMismatch", type: "error" },
  { inputs: [], name: "AllowanceResidue", type: "error" },
  { inputs: [], name: "DuplicateTicket", type: "error" },
  { inputs: [], name: "InvalidTicketOwner", type: "error" },
  { inputs: [], name: "MixedDrawing", type: "error" },
  { inputs: [], name: "NotSettled", type: "error" },
  { inputs: [], name: "NothingToClaim", type: "error" },
  { inputs: [], name: "InvalidBatchSize", type: "error" },
] as const;

// The pool's derived lifecycle, matching IFarpotPool.PoolState by declaration order.
// Do not reorder — the numbers come from the enum, and the contract's test suite asserts them.
export const POOL_STATE = {
  None: 0,
  Accumulating: 1,
  Claimable: 2,
  Settled: 3,
} as const;

// The drawing that was current when FarpotPool was deployed — the first one it could
// possibly hold tickets for. Used as the floor when scanning back for a user's past pools,
// so the lookback never queries drawings that predate the contract.
//
// 143 is the drawing current at the 2026-08-13 redeploy. The pool deploys PAUSED and is
// unpaused only after the frontend is live, so its true first drawing could be later than
// this if the cutover slips past a draw. That direction is deliberate: an over-inclusive
// floor costs one wasted empty-drawing read, an under-inclusive one hides real tickets.
export const POOL_FIRST_DRAWING = BigInt(143);

// How many past drawings the Pool tab checks for an unclaimed share. Bounded because every
// candidate costs two multicall entries. Megapot draws daily, so this is ~6 weeks of history.
// Older pools stay claimable ON-CHAIN forever — `claim()` has no deadline — they would just
// need a log-based lookup to surface in the UI. Revisit if the app is ever idle that long.
export const POOL_HISTORY_LOOKBACK = 45;

// Soft-launch cap on total pool size PER DRAWING, in USDC (6 decimals) — $500.
//
// Advisory, not enforced: the contract has no total cap, `join()` is callable directly, and
// two people can pass the check in the same block and land the pool slightly over. Copy must
// therefore never promise a hard limit. It exists to bound the routine case until the audit,
// and is expressed in USDC rather than tickets so it converts through the LIVE ticket price.
export const POOL_SOFT_CAP_USDC = BigInt(500_000_000);

// Soft-launch cap on SPONSORED value per drawing, in USDC (6 decimals) — $500.
//
// Deliberately a SEPARATE bucket from POOL_SOFT_CAP_USDC rather than a shared one: sharing
// would mean a sponsorship crowds out the joiners it exists to attract. Worst case per drawing
// is therefore $1000 across both. Joiner principal at risk is unchanged; the extra exposure is
// the sponsor's own money plus the joiners' winnings from it.
export const POOL_SPONSOR_SOFT_CAP_USDC = BigInt(500_000_000);

// Minimum sponsored value to be billed in the pool hero — $10.
//
// "Largest sponsor wins" sets only a RELATIVE price: in an otherwise unsponsored drawing a
// single $1 ticket would buy the banner. Anyone may still sponsor below this and is still
// counted in the totals; they just do not get the headline. Display policy, not fund safety.
export const POOL_SPONSOR_BILLING_MIN_USDC = BigInt(10_000_000);

// Base chain ID
export const BASE_CHAIN_ID = 8453;

// Megapot API
export const MEGAPOT_API_BASE = "https://api.megapot.io/v1";

// Jackpot ABI (minimal — read functions + buyTickets)
export const JACKPOT_ABI = [
  {
    inputs: [],
    name: "currentDrawingId",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "getDrawingState",
    // Single struct return. Declaring the 13 fields as flat outputs makes viem
    // return a positional array (named access → undefined); wrapping them in one
    // tuple component is what makes `data.prizePool` etc. resolve by name.
    outputs: [
      {
        components: [
          { internalType: "uint256", name: "prizePool", type: "uint256" },
          { internalType: "uint256", name: "ticketPrice", type: "uint256" },
          { internalType: "uint256", name: "edgePerTicket", type: "uint256" },
          { internalType: "uint256", name: "referralWinShare", type: "uint256" },
          { internalType: "uint256", name: "referralFee", type: "uint256" },
          { internalType: "uint256", name: "globalTicketsBought", type: "uint256" },
          { internalType: "uint256", name: "lpEarnings", type: "uint256" },
          { internalType: "uint64", name: "drawingTime", type: "uint64" },
          { internalType: "bytes32", name: "winningTicket", type: "bytes32" },
          { internalType: "uint8", name: "ballMax", type: "uint8" },
          { internalType: "uint8", name: "bonusballMax", type: "uint8" },
          { internalType: "contract IPayoutCalculator", name: "payoutCalculator", type: "address" },
          { internalType: "bool", name: "jackpotLock", type: "bool" },
        ],
        internalType: "struct DrawingState",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_drawingId", type: "uint256" }],
    name: "getDrawingTierPayouts",
    outputs: [{ internalType: "uint256[12]", name: "", type: "uint256[12]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          { internalType: "uint8[]", name: "normals", type: "uint8[]" },
          { internalType: "uint8", name: "bonusball", type: "uint8" },
        ],
        internalType: "struct Ticket[]",
        name: "_tickets",
        type: "tuple[]",
      },
      { internalType: "address", name: "_recipient", type: "address" },
      { internalType: "address[]", name: "_referrers", type: "address[]" },
      { internalType: "uint256[]", name: "_referralSplit", type: "uint256[]" },
      { internalType: "bytes32", name: "_source", type: "bytes32" },
    ],
    name: "buyTickets",
    // Returns the minted ERC-721 token ids, in mint order. This said `outputs: []`
    // until 2026-07-30, which is harmless for the app (it discards the return) but
    // silently drops the data on the floor for any contract caller. Megapot mints with
    // solady `_mint`, which never fires `onERC721Received`, so this return value is the
    // ONLY way a contract recipient can learn which tickets it just bought — it is the
    // enumeration path FarpotPool depends on.
    // Proven by decoding a live return blob (tx 0xdd01a55c…0389, Base block 49322568):
    // `0x…0020 | …0001 | 0xeb84…c8` decodes as `uint256[]` to exactly the token id the
    // same trace passed to `mintTicket`. Under the old `outputs: []` the identical bytes
    // decode to nothing.
    outputs: [{ internalType: "uint256[]", name: "ticketIds", type: "uint256[]" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    // Claim winnings on past-drawing tickets. Burns the ticket NFTs and pays the
    // USDC prize instantly to the caller. Arg is the on-chain NFT token id
    // (`user_ticket_id` from the Data API), NOT the API's small `id`.
    inputs: [
      { internalType: "uint256[]", name: "_userTicketIds", type: "uint256[]" },
    ],
    name: "claimWinnings",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// Random Ticket Buyer ABI (for quick-pick)
export const RANDOM_TICKET_BUYER_ABI = [
  {
    inputs: [
      { internalType: "uint256", name: "_ticketCount", type: "uint256" },
      { internalType: "address", name: "_recipient", type: "address" },
      { internalType: "address[]", name: "_referrers", type: "address[]" },
      { internalType: "uint256[]", name: "_referralSplit", type: "uint256[]" },
      { internalType: "bytes32", name: "_source", type: "bytes32" },
    ],
    name: "buyTickets",
    // Same correction as the Jackpot entry above — the RandomTicketBuyer returns the
    // minted ids too (it forwards `jackpot.buyTickets`'s return value verbatim). Both
    // calls in the same live trace returned identical `uint256[]` bytes.
    outputs: [{ internalType: "uint256[]", name: "ticketIds", type: "uint256[]" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// JackpotAutoSubscription — recurring subscription contract (Base mainnet)
// Source: https://basescan.org/address/0x2694Bd48f3e6B4775943067DC842C93bf5F19DcD
export const AUTO_SUBSCRIPTION_ADDRESS = "0x2694Bd48f3e6B4775943067DC842C93bf5F19DcD" as const;

// JackpotAutoSubscription ABI (minimal — createSubscription, cancelSubscription, getSubscriptionInfo)
export const AUTO_SUBSCRIPTION_ABI = [
  {
    inputs: [],
    name: "ActiveSubscriptionExists",
    type: "error",
  },
  {
    inputs: [
      { internalType: "address", name: "_recipient", type: "address" },
      { internalType: "uint64", name: "_totalDays", type: "uint64" },
      { internalType: "uint64", name: "_dynamicTicketCount", type: "uint64" },
      {
        components: [
          { internalType: "uint8[]", name: "normals", type: "uint8[]" },
          { internalType: "uint8", name: "bonusball", type: "uint8" },
        ],
        internalType: "struct IJackpot.Ticket[]",
        name: "_userStaticTickets",
        type: "tuple[]",
      },
      { internalType: "address[]", name: "_referrers", type: "address[]" },
      { internalType: "uint256[]", name: "_referralSplit", type: "uint256[]" },
      { internalType: "bytes32", name: "_source", type: "bytes32" },
    ],
    name: "createSubscription",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "cancelSubscription",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "getSubscriptionInfo",
    outputs: [
      {
        components: [
          {
            components: [
              { internalType: "uint64", name: "remainingUSDC", type: "uint64" },
              { internalType: "uint64", name: "lastExecutedDrawing", type: "uint64" },
              { internalType: "uint64", name: "subscribedTicketPrice", type: "uint64" },
              { internalType: "uint64", name: "dynamicTicketCount", type: "uint64" },
              { internalType: "address[]", name: "referrers", type: "address[]" },
              { internalType: "uint256[]", name: "referralSplit", type: "uint256[]" },
              { internalType: "bytes32", name: "source", type: "bytes32" },
            ],
            internalType: "struct JackpotAutoSubscription.Subscription",
            name: "subscription",
            type: "tuple",
          },
          {
            components: [
              { internalType: "uint8[]", name: "normals", type: "uint8[]" },
              { internalType: "uint8", name: "bonusball", type: "uint8" },
            ],
            internalType: "struct IJackpot.Ticket[]",
            name: "staticTickets",
            type: "tuple[]",
          },
        ],
        internalType: "struct JackpotAutoSubscription.SubscriptionInfo",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// USDC ABI (ERC-20 minimal)
export const USDC_ABI = [
  {
    inputs: [
      { internalType: "address", name: "account", type: "address" },
    ],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

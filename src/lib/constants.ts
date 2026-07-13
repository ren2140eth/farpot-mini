// Megapot v2 Contract Addresses (Base mainnet)
// Source: https://docs.megapot.io/developers/contract-overview

export const JACKPOT_ADDRESS = "0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2" as const;
export const RANDOM_TICKET_BUYER_ADDRESS = "0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd" as const;
export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const PAYOUT_CALCULATOR_ADDRESS = "0x97a22361b6208aC8cd9afaea09D20feC47046CBD" as const;

// Referral wallet — earns the referral fee on every ticket sale.
// Passed as the `_referrers[0]` arg on each buy; fees are claimed with
// `claimReferralFees()`.
export const REFERRAL_WALLET = "0xeEeC2d83DA24512D37410F7cA5B18FD805fB79d2" as const;

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
    outputs: [],
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
    outputs: [],
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
          { internalType: "bool", name: "isActive", type: "bool" },
          { internalType: "uint64", name: "daysRemaining", type: "uint64" },
          { internalType: "uint256", name: "balance", type: "uint256" },
          { internalType: "uint64", name: "dynamicTicketCount", type: "uint64" },
          {
            components: [
              { internalType: "uint8[]", name: "normals", type: "uint8[]" },
              { internalType: "uint8", name: "bonusball", type: "uint8" },
            ],
            internalType: "struct IJackpot.Ticket[]",
            name: "staticTickets",
            type: "tuple[]",
          },
          { internalType: "address[]", name: "referrers", type: "address[]" },
          { internalType: "uint256[]", name: "referralSplit", type: "uint256[]" },
        ],
        internalType: "struct SubscriptionInfo",
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

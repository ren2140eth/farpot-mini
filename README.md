# Farpot

A [Farcaster Mini App](https://miniapps.farcaster.xyz) for buying and **gifting**
[Megapot](https://megapot.io) lottery tickets on [Base](https://base.org) —
straight from your feed. 1 USDC per ticket, daily drawings, real prizes.

**Live:** https://farpot.vercel.app

> Farpot is an independent community front-end. It is **not** affiliated with or
> endorsed by Megapot — it's *powered by* Megapot's public, permissionless
> on-chain lottery contracts. "Megapot" is a trademark of its respective owner;
> used here for descriptive attribution only.

## Features

- 🎰 Buy Megapot tickets in-app — pick your own 5 + bonusball, or quick-pick
- 🎁 **Gift a ticket** to any Farcaster user by `@username` (resolves their
  verified Base address via Neynar)
- 🏆 Results tab — past drawings + your own ticket history, with in-app
  **claim winnings**
- 📣 Share-to-cast after a buy, plus optional post-draw "check your results"
  notifications
- 🟣 Signed Farcaster manifest — renders as a Mini App embed in Farcaster clients
- ⚡ USDC `approve` → buy flow via wagmi + viem on Base

## Stack

- [Next.js 16](https://nextjs.org) (App Router)
- [OnchainKit + MiniKit](https://docs.base.org/onchainkit)
- [wagmi](https://wagmi.sh) / [viem](https://viem.sh)
- [Farcaster Mini App SDK](https://miniapps.farcaster.xyz)
- [Neynar](https://neynar.com) for `@username` → address resolution

## Getting started

```bash
git clone --recurse-submodules https://github.com/ren2140eth/farpot-mini
cd farpot-mini
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

Open http://localhost:3000.

Already cloned without `--recurse-submodules`? The contracts in
[`contracts/`](./contracts) depend on two pinned submodules:

```bash
git submodule update --init --recursive
```

The frontend builds and runs fine without them — they are only needed for
`npm run forge:*`.

### Environment

See [`.env.example`](./.env.example). The app runs against public Base RPCs out
of the box; an [OnchainKit API key](https://portal.cdp.coinbase.com) and a
[Neynar key](https://neynar.com) unlock wallet RPC and gift-by-handle lookup.
Nothing secret is committed — `.env*` is gitignored.

Contract addresses, ABIs, and the referral wallet live in
[`src/lib/constants.ts`](./src/lib/constants.ts) — the single source of truth.
The flow is always USDC `approve` → `buyTickets`.

### Contracts

[`contracts/`](./contracts) is a [Foundry](https://getfoundry.sh) project, pinned
to solc 0.8.28 to match the deployed Megapot contracts. Dependencies are git
submodules at release tags: forge-std `v1.16.2`, solady `v0.1.26`.

```bash
npm run forge:build
npm run forge:test
npm run forge:gas                       # gas report
BASE_RPC_URL=... npm run forge:fork     # tests against live Base state
```

These wrap `forge` via [`scripts/forge.sh`](./scripts/forge.sh), which fails with
a clear message if the submodules are uninitialised or a fork run has no RPC URL.
`contracts/` is excluded from the Next.js typecheck, so Solidity work cannot
affect the app build.

## Deploying your own

1. Deploy to Vercel and set the env vars (set `NEXT_PUBLIC_URL` to your final domain).
2. **Re-sign the manifest for your domain.** The `accountAssociation` in
   [`src/lib/minikit.config.ts`](./src/lib/minikit.config.ts) is bound to
   `farpot.vercel.app` and signed by the original author's Farcaster account — it
   will **not** validate on your domain. Regenerate it with the
   [Farcaster Manifest Tool](https://farcaster.xyz/~/developers) and replace those
   three values.
3. The `REFERRAL_WALLET` in `constants.ts` earns the protocol's 10% referral fee
   on each sale. Point it at your own address if you deploy your own instance.

## License

[MIT](./LICENSE) © ren2140eth

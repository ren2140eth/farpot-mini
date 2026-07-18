# Plan: Unified Ticket Builder

- created: 2026-07-17T00:00:00-07:00
- modified: 2026-07-17T18:33:29-07:00
- commits:
- agent: Codex
- session:
- back refs: `AGENTS.md` Feature 5 and buy-flow proof requirements

## Purpose
Replace the competing pick/quick tabs with one playful ticket builder: shuffled editable slips for small one-time purchases, on-chain randomness for large and recurring purchases, and a direct manual number-picker modal.

## Problem
The current interface exposes separate PICK NUMBERS and QUICK PICK modes even though manual mode already has a shuffle action. It also duplicates one selected combination across every ticket in a multi-ticket pick purchase. Recurring purchases can currently carry static chosen numbers, despite the intended simpler behavior of fresh on-chain random numbers. Contract routing and allowance state depend on the visible mode toggle, making the interface and transaction path more coupled than necessary.

## Solution
Derive the purchase route from context: one-time quantities of 1–10 use an array of editable client-generated slips, while quantities above 10 and all recurring purchases use on-chain randomness. Render the slips in a single landing flow with a prominent haptic shuffle action, and open a focused “Pick your numbers” modal when a slip is tapped.

## Relevant files
- existing: `src/app/page.tsx` — ticket state, buy routing, recurring flow, gift flow, and primary UI
- existing: `src/app/globals.css` — ticket builder and modal presentation
- existing: `scripts/encode-buy-proof.ts` — standing pick/quick calldata and referral proof

## Implementation phases
Status markers: `[ ]` idle · `[~]` in progress · `[x]` done · `[f]` failed.
Execute phases in order, top to bottom. Do not start a phase until the prior one resolves.

### [x] Phase 1: Model slips and derived routing
Replace the global mode/selection state with per-slip selections and a transaction route derived from quantity, recurring state, and gift context.

Tasks:
- [x] Maintain 1–10 distinct valid slip selections as quantity changes.
- [x] Route quantities above 10 and every recurring purchase through on-chain random contracts.
- [x] Keep allowance, validation, reset, reveal, and referral behavior aligned with the derived route.

Testing strategy: Typecheck through the production build and inspect all remaining legacy mode references.
- [x] `rg -n 'mode ===|setMode|switchMode' src/app/page.tsx` — no stale user-selectable buy mode remains

🔁 Do not exit this phase until every box above is checked. On failure, fix the cause and re-run.

### [x] Phase 2: Build the unified ticket interaction
Replace mode tabs and inline picker with the shuffle-first ticket slip stack and manual picker modal.

Tasks:
- [x] Add prominent shuffle-all control with haptics.
- [x] Render up to ten individually editable slips.
- [x] Add an accessible “Pick your numbers” modal for editing one slip.
- [x] Show clear on-chain messaging for 11+ tickets and recurring purchases.
- [x] Preserve gift purchasing in the unified model.

Testing strategy: Browser-check mobile layout, modal interaction, quantity transitions, and recurring transitions.
- [x] `npm run build` — compile and production-render the redesigned page

🔁 Do not exit this phase until every box above is checked. On failure, fix the cause and re-run.

### [x] Phase 3: Validate transaction safety and UX
Prove both contract paths still encode and the redesigned interaction has no obvious runtime regressions.

Tasks:
- [x] Run the standing pick and quick calldata proof with referral assertions.
- [x] Verify a small purchase encodes distinct slip values rather than duplicating one selection.
- [f] Check the mobile page and modal with no console errors. Local headless Chrome remained on the live jackpot loading state; requires a connected-wallet preview/device pass.

Testing strategy: Use the repository proof script, production build, and browser automation or equivalent inspection.
- [x] `node --experimental-strip-types scripts/encode-buy-proof.ts` — both buy paths encode and include `REFERRAL_WALLET`
- [x] `npm run build` — final production build

🔁 Do not exit this phase until every box above is checked. On failure, fix the cause and re-run.

## Global validation
- [x] `git diff --check` — no whitespace errors
- [x] `npm run build` — final build passes
- [x] `node --experimental-strip-types scripts/encode-buy-proof.ts` — pick and on-chain random paths retain referral calldata

🔁 The plan is not complete until every box is checked and every command passes.
If a step is genuinely impossible, mark it `[f]`, note why, and move on.

## Notes
- The 10-ticket cutoff is exclusive routing: 1–10 editable slips use Jackpot `buyTickets`; 11+ use RandomTicketBuyer. The UI will not split one checkout across two contracts.
- Gift purchases remain fully on-chain random as before; recurring gifts remain unsupported.
- The modal title is exactly “Pick your numbers”.
- Targeted lint has zero new errors; the remaining four errors are the pre-existing hooks baseline documented in `AGENTS.md`.

## Amendments

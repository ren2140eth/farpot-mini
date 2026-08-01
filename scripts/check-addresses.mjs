#!/usr/bin/env node
// Fails if the Megapot addresses in Solidity disagree with src/lib/constants.ts.
//
// constants.ts is the project's declared source of truth, but Solidity cannot import from
// TypeScript, so contracts/src/MegapotAddresses.sol necessarily holds a second copy. This
// check is what keeps that copy honest — without it, the Solidity side could drift from the
// app for months and every test would still pass, because the tests and the drifted address
// would simply agree with each other.
//
// Phase 7's deploy script reads addresses from env and asserts them against the deployed
// immutables; this covers the test/app half of the same problem.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ts = readFileSync(join(root, "src/lib/constants.ts"), "utf8");
const sol = readFileSync(join(root, "contracts/src/MegapotAddresses.sol"), "utf8");

/** name in constants.ts -> name in MegapotAddresses.sol */
const PAIRS = [
  ["JACKPOT_ADDRESS", "JACKPOT"],
  ["RANDOM_TICKET_BUYER_ADDRESS", "RANDOM_TICKET_BUYER"],
  ["JACKPOT_TICKET_NFT_ADDRESS", "TICKET_NFT"],
  ["USDC_ADDRESS", "USDC"],
  ["REFERRAL_WALLET", "REFERRAL_WALLET"],
];

function fromTs(name) {
  const m = ts.match(new RegExp(`export const ${name}\\s*=\\s*"(0x[0-9a-fA-F]{40})"`));
  return m?.[1];
}

function fromSol(name) {
  const m = sol.match(new RegExp(`address internal constant ${name}\\s*=\\s*(0x[0-9a-fA-F]{40})`));
  return m?.[1];
}

let failed = 0;
for (const [tsName, solName] of PAIRS) {
  const a = fromTs(tsName);
  const b = fromSol(solName);

  if (!a) {
    console.error(`MISSING  ${tsName} not found in src/lib/constants.ts`);
    failed++;
    continue;
  }
  if (!b) {
    console.error(`MISSING  ${solName} not found in contracts/src/MegapotAddresses.sol`);
    failed++;
    continue;
  }
  // Compare case-insensitively: the two files use different EIP-55 checksum renderings of
  // the same address, which is not a drift.
  if (a.toLowerCase() !== b.toLowerCase()) {
    console.error(`DRIFT    ${tsName}\n           ts : ${a}\n           sol: ${b}`);
    failed++;
    continue;
  }
  console.log(`ok       ${tsName.padEnd(28)} ${a}`);
}

if (failed > 0) {
  console.error(`\n${failed} address mismatch(es). constants.ts is the source of truth.`);
  process.exit(1);
}
console.log(`\nAll ${PAIRS.length} addresses agree between constants.ts and Solidity.`);

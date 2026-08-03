// Redis-backed cache for the pool's contributor scan.
//
// Storage is the same Upstash REST instance the notification tokens use, via the same
// env-var pair (native Upstash names or Vercel's KV_* aliases).
//
// ── Why this stores an ADDRESS SET rather than accumulated per-address totals ──
//
// The design (§5) called for accumulating per-address ticket totals from `Joined` logs, with
// `(txHash, logIndex)` dedupe keys, and required cursor+totals+dedupe to be committed as ONE
// atomic unit (Lua or MULTI) because "dedupe alone does not help if totals and dedupe keys can
// commit separately".
//
// This stores the SET of contributor addresses instead, and reads every ticket weight back
// from the chain (`poolOf` / `ticketsByUser`). That is a strictly stronger position:
//
//   * `SADD` is idempotent, so processing the same log twice is a no-op. Double-counting is
//     not prevented by bookkeeping, it is impossible by construction — which removes the
//     failure mode the dedupe keys and the atomic-commit requirement both existed to guard.
//   * Weights come from contract state, so a cached number can never drift from the chain.
//     Accumulated log totals can, and nothing would notice.
//
// What remains load-bearing is the WRITE ORDER: addresses are SADD-ed first and the cursor is
// advanced last. A failure between the two re-scans a range that is idempotent to re-scan.
// The reverse order would advance past blocks whose contributors were never stored, losing
// them permanently — the one genuinely unrecoverable outcome here.

import { Redis } from "@upstash/redis";

// Accept either the native Upstash names or Vercel's Upstash-integration names — the
// Marketplace injects KV_REST_API_*, and this project is provisioned that way.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

export const cacheEnabled = Boolean(REDIS_URL && REDIS_TOKEN);

// The official SDK rather than hand-rolled REST calls.
//
// The notification store next door hand-rolls the same protocol and has been fine in
// production for months, but it only uses commands whose reply shape is obvious
// (GET/SET/SADD/SMEMBERS/DEL). The scan lock needs `SET … NX EX`, whose reply convention
// ("OK" vs null) I could not verify: Vercel marks these credentials Sensitive, so they cannot
// be pulled in plaintext and the assumption cannot be tested locally. Guessing it wrong in the
// SUCCESS direction would be silent and bad — the lock would never be acquired, no instance
// would ever scan, and the contributor list would stay permanently empty while every health
// signal looked fine. The SDK removes the guess.
const redis =
  REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

function client(): Redis {
  if (!redis) throw new Error("pool cache not configured");
  return redis;
}

// Bump to invalidate every cached entry at once. A schema change without a bump would leave
// old-shaped values in place and there is no migration path for a cache.
const V = "v1";
const CURSOR_KEY = `mm:pool:${V}:cursor`;
const LOCK_KEY = `mm:pool:${V}:lock`;
const addrsKey = (drawingId: bigint) => `mm:pool:${V}:addrs:${drawingId}`;
// Reverse index: every drawing a wallet has ever joined. Populated by the SAME scan that fills
// the forward index, so it costs no extra RPC and can never disagree with it.
const mineKey = (address: string) => `mm:pool:${V}:mine:${address.toLowerCase()}`;
const frozenKey = (drawingId: bigint) => `mm:pool:${V}:frozen:${drawingId}`;

// Long enough to cover a bounded cold scan (many 10k-block chunks against a rate-limited RPC),
// short enough that a crashed holder frees it reasonably quickly.
const LOCK_TTL_SECONDS = 120;

// Note the SDK is configured with `automaticDeserialization` left at its default, and every
// value written here is a plain string or set member, so nothing round-trips through JSON.
//
// Errors are NOT swallowed. The caller must be able to tell "Redis is down" from "nothing
// cached yet": treating the former as the latter would silently restart the cursor from the
// deployment block on every blip, the same conflation that once dropped a day's notifications.

/** Last block scanned into the cache, or null when nothing has been scanned yet. */
export async function getCursor(): Promise<bigint | null> {
  const raw = await client().get<string | number | null>(CURSOR_KEY);
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return BigInt(raw);
  } catch {
    // A corrupt cursor is not recoverable by guessing. Report absence so the caller does a
    // cold rebuild, which is bounded and correct by construction.
    return null;
  }
}

/** Advance the cursor. MUST be called only after the range's addresses are stored. */
export async function setCursor(block: bigint): Promise<void> {
  await client().set(CURSOR_KEY, block.toString());
}

/** Idempotent: re-adding a known contributor changes nothing. */
export async function addContributors(drawingId: bigint, addresses: string[]): Promise<void> {
  if (addresses.length === 0) return;
  const members = addresses.map((a) => a.toLowerCase());
  await client().sadd(addrsKey(drawingId), members[0], ...members.slice(1));
}

/**
 * Record which drawings a wallet has joined. Idempotent, like the forward index.
 *
 * This exists so the claim UI has NO expiry window. A bounded look-back over recent drawings
 * is cheap but recreates the original defect on a delay: a user returning after the window has
 * passed can no longer discover — or claim — winnings that are still theirs on-chain forever.
 */
export async function addContributorDrawings(
  address: string,
  drawingIds: bigint[],
): Promise<void> {
  if (drawingIds.length === 0) return;
  const members = drawingIds.map((d) => d.toString());
  await client().sadd(mineKey(address), members[0], ...members.slice(1));
}

/** Every drawing this wallet has joined, oldest-first ordering not guaranteed. */
export async function getContributorDrawings(address: string): Promise<bigint[]> {
  const raw = (await client().smembers<string[]>(mineKey(address))) ?? [];
  return raw
    .map((d) => {
      try {
        return BigInt(d);
      } catch {
        return null;
      }
    })
    .filter((d): d is bigint => d !== null)
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
}

export async function getContributors(drawingId: bigint): Promise<string[]> {
  return (await client().smembers<string[]>(addrsKey(drawingId))) ?? [];
}

/**
 * Mark a drawing's contributor list as provably complete.
 *
 * Callers must only do this once the cursor has passed a block at which `currentDrawingId`
 * was ALREADY greater than `drawingId` — see the route for why reading the drawing id at the
 * confirmed head (rather than at `latest`) is what makes the three §5 conditions hold.
 */
export async function freezeDrawing(drawingId: bigint): Promise<void> {
  await client().set(frozenKey(drawingId), "1");
}

export async function isFrozen(drawingId: bigint): Promise<boolean> {
  return (await client().get<string | null>(frozenKey(drawingId))) === "1";
}

/**
 * Take the scan lock. Returns an ownership token, or null if another instance holds it.
 *
 * Correctness of the DATA does not depend on this — set writes are idempotent and a regressed
 * cursor only causes an idempotent re-scan — but two instances scanning at once multiplies RPC
 * work against a rate-limited endpoint, so the lock is worth having and worth having correct.
 *
 * The token is what makes release safe. An earlier version wrote a constant "1" and released
 * with an unconditional DEL, which lets a slow holder delete its SUCCESSOR's lock: if scan A
 * overruns the TTL, B acquires the freed key, then A finishes and deletes B's lock, admitting
 * a third scan while B is still running. Every holder now deletes only its own lock.
 */
export async function acquireLock(): Promise<string | null> {
  const token = crypto.randomUUID();
  const res = await client().set(LOCK_KEY, token, { nx: true, ex: LOCK_TTL_SECONDS });
  return res === "OK" ? token : null;
}

/** Compare-and-delete: releases the lock only if this caller still owns it. */
export async function releaseLock(token: string): Promise<void> {
  // GET-then-DEL from the client would race in exactly the window this exists to close, so the
  // comparison has to happen inside Redis.
  await client().eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
    [LOCK_KEY],
    [token],
  );
}

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

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

export const cacheEnabled = Boolean(REDIS_URL && REDIS_TOKEN);

// Bump to invalidate every cached entry at once. A schema change without a bump would leave
// old-shaped values in place and there is no migration path for a cache.
const V = "v1";
const CURSOR_KEY = `mm:pool:${V}:cursor`;
const LOCK_KEY = `mm:pool:${V}:lock`;
const addrsKey = (drawingId: bigint) => `mm:pool:${V}:addrs:${drawingId}`;
const frozenKey = (drawingId: bigint) => `mm:pool:${V}:frozen:${drawingId}`;

// Long enough to cover a cold scan, short enough that a crashed holder frees it quickly.
const LOCK_TTL_SECONDS = 30;

// Unlike the notifications helper, this THROWS on transport failure instead of returning
// null. The caller must be able to tell "Redis is down" from "nothing cached yet": treating
// the former as the latter would silently restart the cursor from the deployment block on
// every blip, which is the same conflation that once dropped a day's notifications.
async function redis<T = unknown>(command: (string | number)[]): Promise<T | null> {
  if (!cacheEnabled) throw new Error("pool cache not configured");
  const res = await fetch(REDIS_URL as string, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`redis ${command[0]} failed: ${res.status}`);
  const json = (await res.json()) as { result: T };
  return json.result ?? null;
}

/** Last block scanned into the cache, or null when nothing has been scanned yet. */
export async function getCursor(): Promise<bigint | null> {
  const raw = await redis<string | number | null>(["GET", CURSOR_KEY]);
  if (raw === null || raw === "") return null;
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
  await redis(["SET", CURSOR_KEY, block.toString()]);
}

/** Idempotent: re-adding a known contributor changes nothing. */
export async function addContributors(drawingId: bigint, addresses: string[]): Promise<void> {
  if (addresses.length === 0) return;
  await redis(["SADD", addrsKey(drawingId), ...addresses.map((a) => a.toLowerCase())]);
}

export async function getContributors(drawingId: bigint): Promise<string[]> {
  return (await redis<string[]>(["SMEMBERS", addrsKey(drawingId)])) ?? [];
}

/**
 * Mark a drawing's contributor list as provably complete.
 *
 * Callers must only do this once the cursor has passed a block at which `currentDrawingId`
 * was ALREADY greater than `drawingId` — see the route for why reading the drawing id at the
 * confirmed head (rather than at `latest`) is what makes the three §5 conditions hold.
 */
export async function freezeDrawing(drawingId: bigint): Promise<void> {
  await redis(["SET", frozenKey(drawingId), "1"]);
}

export async function isFrozen(drawingId: bigint): Promise<boolean> {
  return (await redis<string | null>(["GET", frozenKey(drawingId)])) === "1";
}

/**
 * Take the scan lock. Returns false if another instance holds it.
 *
 * Correctness does not depend on this — set writes are idempotent and the cursor only moves
 * forward — but two Vercel instances scanning the same range at once is pure waste against a
 * rate-limited RPC, and losing the lock is a reason to serve cached data, not to fail.
 */
export async function acquireLock(): Promise<boolean> {
  const res = await redis<string | null>(["SET", LOCK_KEY, "1", "NX", "EX", LOCK_TTL_SECONDS]);
  return res === "OK";
}

export async function releaseLock(): Promise<void> {
  await redis(["DEL", LOCK_KEY]);
}

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

// Bumped v1 → v2 for the sponsor-capable pool redeploy. NONE of these keys contains the pool
// address, so every one of them describes the previous contract after a redeploy. Bumping the
// namespace orphans all of them at once; deleting an enumerated list would eventually miss one.
// Bump again on any future pool redeploy.
const V = "v2";
const CURSOR_KEY = `mm:pool:${V}:cursor`;
const LOCK_KEY = `mm:pool:${V}:lock`;
const addrsKey = (drawingId: bigint) => `mm:pool:${V}:addrs:${drawingId}`;
// Reverse index: every drawing a wallet has ever joined. Populated by the SAME scan that fills
// the forward index, so it costs no extra RPC and can never disagree with it.
const mineKey = (address: string) => `mm:pool:${V}:mine:${address.toLowerCase()}`;
const frozenKey = (drawingId: bigint) => `mm:pool:${V}:frozen:${drawingId}`;
// Sponsors are stored SEPARATELY from contributors and deliberately do NOT feed `mineKey` — see
// `addSponsors` below.
const sponsorsKey = (drawingId: bigint) => `mm:pool:${V}:sponsors:${drawingId}`;

// ── cron crank + monitoring state (Phase 9) ────────────────────────────────────────────────
// Lowest drawing id not yet known to be fully drained. Purely a "where to start looking" hint:
// losing it costs a bounded re-scan, never correctness, because `poolOf` is authoritative about
// what still needs claiming.
const CRANK_CURSOR_KEY = `mm:pool:${V}:crank:cursor`;
// A drawing whose crank hit a non-resizable revert. Recorded so the daily tick stops retrying
// it forever, and so it stays visible in the route's response instead of vanishing.
const haltKey = (drawingId: bigint) => `mm:pool:${V}:crank:halt:${drawingId}`;
// The set of every halted drawing, kept ALONGSIDE the per-drawing reason.
//
// Needed because the crank cursor advances past a halt (a jam must not wall off later
// drawings), which means the scan window stops covering it — and a drawing nothing inspects is
// a drawing nothing reports. Without this set a jam would alert exactly once and then go silent
// forever while real winnings stayed stuck, which is the same shape as the Phase 8 defect where
// claims quietly stopped being offered.
const HALT_SET_KEY = `mm:pool:${V}:crank:halted`;
// Last observed drawing id, for §8.1's "has not advanced" half of the staleness test.
const STALE_ID_KEY = `mm:pool:${V}:stale:lastid`;
// Consecutive runs where cranking could not complete. Escalation is based on PERSISTENCE, not on
// any single failure: one RPC blip is noise, but the same blip every day means the money path has
// silently stopped and nobody has been told.
const FAIL_STREAK_KEY = `mm:pool:${V}:crank:failstreak`;
const alertKey = (kind: string, key: string) => `mm:pool:${V}:alert:${kind}:${key}`;

// Alerts re-fire weekly rather than never: an unfixed jam should resurface, just not daily.
const ALERT_TTL_SECONDS = 7 * 24 * 60 * 60;

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
 * Sponsors are stored SEPARATELY from contributors, and deliberately do NOT feed the `mine`
 * reverse index. Folding them in would surface sponsor-only drawings as joiner claim history,
 * offering the user a claim path that correctly pays zero.
 */
export async function addSponsors(drawingId: bigint, addresses: string[]): Promise<void> {
  if (addresses.length === 0) return;
  const members = addresses.map((a) => a.toLowerCase());
  await client().sadd(sponsorsKey(drawingId), members[0], ...members.slice(1));
}

export async function getSponsors(drawingId: bigint): Promise<string[]> {
  return (await client().smembers<string[]>(sponsorsKey(drawingId))) ?? [];
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

/**
 * Lowest drawing the crank still needs to look at, or null when nothing is recorded.
 *
 * Unlike the scan cursor, this one is advisory. The crank re-derives what needs claiming from
 * `poolOf` every run, so a missing or stale value only widens the window it inspects.
 */
export async function getCrankCursor(): Promise<bigint | null> {
  const raw = await client().get<string | number | null>(CRANK_CURSOR_KEY);
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

export async function setCrankCursor(drawingId: bigint): Promise<void> {
  await client().set(CRANK_CURSOR_KEY, drawingId.toString());
}

/**
 * Record that a drawing's crank failed in a way that must NOT be retried (design §4: "any other
 * deterministic revert → alert and stop").
 *
 * Halts are per-drawing on purpose. A jam is a property of one drawing's ticket list, so
 * halting the whole cron would let a single stuck drawing block claims for every later one —
 * which is the same "quietly stops offering money that is still owed" defect Phase 8's second
 * sweep found in the UI.
 */
export interface HaltRecord {
  kind: "crank-fatal" | "crank-terminal";
  reason: string;
}

/**
 * Persist a halt. **Set membership first, detail second** — the same write-order rule the scan
 * cursor documents, for the same reason.
 *
 * Discovery is what cannot be reconstructed: if the SADD lands and the detail write fails, the
 * drawing is still found by `listHalts` and merely reports a vague reason. In the other order a
 * failure leaves a drawing that `getHalt` knows about but `listHalts` cannot enumerate — and
 * since the crank cursor moves past halts, nothing would ever look at it again.
 *
 * Errors are NOT swallowed. The caller must be able to tell a recorded halt from a lost one.
 */
export async function recordHalt(drawingId: bigint, record: HaltRecord): Promise<void> {
  await client().sadd(HALT_SET_KEY, drawingId.toString());
  await client().set(haltKey(drawingId), JSON.stringify(record));
}

/**
 * The halt record for a drawing, or null if it is not halted.
 *
 * Tolerates the pre-JSON shape (a bare reason string) rather than throwing on it: a cache is not
 * migratable, and a parse failure here would make a halted drawing read as healthy and get
 * retried — the one outcome the halt exists to prevent.
 */
export async function getHalt(drawingId: bigint): Promise<HaltRecord | null> {
  // `unknown`, not `string`, because the SDK's automatic deserialization PARSES stored JSON back
  // into an object on the way out. Typing this as a string does not make it one — it just hides
  // the object behind a lie, and `JSON.parse` of an object stringifies it to "[object Object]"
  // and throws, silently downgrading every halt to the legacy shape with a useless reason and
  // the wrong kind. That wrong kind then defeats alert dedupe and pages daily.
  const raw = await client().get<unknown>(haltKey(drawingId));
  if (raw === null || raw === undefined || raw === "") return null;

  const parsed: unknown = typeof raw === "string" ? tryParse(raw) : raw;
  if (parsed && typeof parsed === "object" && typeof (parsed as HaltRecord).reason === "string") {
    const record = parsed as Partial<HaltRecord>;
    return {
      kind: record.kind === "crank-terminal" ? "crank-terminal" : "crank-fatal",
      reason: record.reason as string,
    };
  }
  // A bare string is the pre-JSON shape. Keep reading it rather than treating it as absent: a
  // halt that reads as healthy gets retried, which is the one thing the halt exists to prevent.
  return { kind: "crank-fatal", reason: String(raw) };
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Every drawing currently halted, so a jam stays reported after the cursor has moved past it. */
export async function listHalts(): Promise<bigint[]> {
  const raw = (await client().smembers<string[]>(HALT_SET_KEY)) ?? [];
  return raw
    .map((d) => {
      try {
        return BigInt(d);
      } catch {
        return null;
      }
    })
    .filter((d): d is bigint => d !== null)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Last drawing id the monitor saw, for the "has not advanced" half of the §8.1 test. */
export async function getLastSeenDrawingId(): Promise<bigint | null> {
  const raw = await client().get<string | number | null>(STALE_ID_KEY);
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

export async function setLastSeenDrawingId(drawingId: bigint): Promise<void> {
  await client().set(STALE_ID_KEY, drawingId.toString());
}

/** Consecutive failed/skipped crank runs. Zero when the last run completed. */
export async function getCrankFailStreak(): Promise<number> {
  const raw = await client().get<string | number | null>(FAIL_STREAK_KEY);
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function bumpCrankFailStreak(): Promise<number> {
  return await client().incr(FAIL_STREAK_KEY);
}

export async function clearCrankFailStreak(): Promise<void> {
  await client().set(FAIL_STREAK_KEY, "0");
}

export async function alertAlreadySent(kind: string, key: string): Promise<boolean> {
  return (await client().get<string | null>(alertKey(kind, key))) !== null;
}

export async function markAlertSent(kind: string, key: string): Promise<void> {
  await client().set(alertKey(kind, key), String(Date.now()), { ex: ALERT_TTL_SECONDS });
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

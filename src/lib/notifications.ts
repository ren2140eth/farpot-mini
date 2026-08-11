// ──────────────────────────────────────────────────────────────────────
// Notification token store + sender for Megapot Mini.
//
// Storage: Upstash Redis (REST) when UPSTASH_REDIS_REST_URL / _TOKEN are set;
// otherwise every call is a logged no-op so dev/build never crashes.
//   Upstash IS provisioned (Vercel Marketplace → "upstash-kv-citron-engine"), and
//   KV_REST_API_URL / KV_REST_API_TOKEN are set for Production and Preview. The old
//   TODO here outlived the work and wrongly implied the store was unavailable — it
//   was taken at face value once and led to a wrong statement about prod. Note that
//   the credentials are marked SENSITIVE in Vercel, so `vercel env pull` returns
//   [SENSITIVE] and they cannot be exercised from a local machine.
//
// Farcaster notification spec (verified against
// https://miniapps.farcaster.xyz/docs/guides/notifications):
//   • tokens are per-user AND per-client; each carries its own send `url`
//   • send: POST <url> { notificationId, title, body, targetUrl, tokens[] }
//   • limits: title ≤ 32, body ≤ 128, targetUrl ≤ 1024, ≤ 100 tokens / request
//   • rate: 1 notif / 30s / token, 100 / day / token
// ──────────────────────────────────────────────────────────────────────

export interface NotificationToken {
  token: string;
  url: string;
}

// Accept either the native Upstash names or Vercel's Upstash-integration names
// (the Vercel Marketplace injects KV_REST_API_URL / KV_REST_API_TOKEN — same
// Upstash REST endpoint + bearer token, identical wire protocol).
const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const storageEnabled = Boolean(REDIS_URL && REDIS_TOKEN);

async function redis<T = unknown>(command: (string | number)[]): Promise<T | null> {
  if (!storageEnabled) {
    console.warn("[notifications] storage not configured — skipping:", command[0]);
    return null;
  }
  try {
    const res = await fetch(REDIS_URL as string, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result: T };
    return json.result;
  } catch (err) {
    console.error("[notifications] redis error:", err);
    return null;
  }
}

const tokenKey = (fid: number | string) => `mm:notif:token:${fid}`;
const FID_INDEX = "mm:notif:fids";
const DRAW_MARKER = "mm:notif:lastDraw";
const MARKER_INITIALIZED = "mm:notif:markerInitialized";

// ── Token lifecycle (called from the webhook) ────────────────────────
export async function saveToken(fid: number, details: NotificationToken) {
  await redis(["SET", tokenKey(fid), JSON.stringify(details)]);
  await redis(["SADD", FID_INDEX, String(fid)]);
}

export async function removeToken(fid: number) {
  await redis(["DEL", tokenKey(fid)]);
  await redis(["SREM", FID_INDEX, String(fid)]);
}

export async function allTokens(): Promise<NotificationToken[]> {
  const fids = (await redis<string[]>(["SMEMBERS", FID_INDEX])) ?? [];
  if (fids.length === 0) return [];
  const keys = fids.map((f) => tokenKey(f));
  const raw = (await redis<(string | null)[]>(["MGET", ...keys])) ?? [];
  const out: NotificationToken[] = [];
  for (const r of raw) {
    if (!r) continue;
    try {
      out.push(JSON.parse(r) as NotificationToken);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// ── "Have we already notified for this draw?" marker ─────────────────
// Returns bigint if a marker exists, throws on Redis error, returns null only
// when the key is genuinely absent (first-ever run). The old behaviour conflated
// "Redis down" with "no marker yet" — both returned null — which meant a transient
// Redis failure silently reset the marker and dropped that day's notification.
export async function getDrawMarker(): Promise<bigint | null> {
  // When storage is not configured at all, every call is a no-op → return null.
  // The handler treats null as "first run" and seeds the marker, which is correct
  // because without persistence the marker can't survive across invocations anyway.
  if (!storageEnabled) {
    return null;
  }

  // Probe Redis connectivity with a cheap key that should always exist (the FID set).
  // SMEMBERS on an empty set returns [], not null — so null means the connection failed.
  const probe = await redis<string[] | null>(["SMEMBERS", FID_INDEX]);
  if (probe === null) {
    throw new Error("Redis unreachable — cannot read draw marker");
  }

  // Check if the marker has ever been initialised. A separate sentinel key means
  // a Redis network blip on GET DRAW_MARKER won't be confused with first-run.
  const initialized = await redis<string | null>(["GET", MARKER_INITIALIZED]);
  if (initialized == null) {
    // Marker has never been initialised — genuine first-run.
    return null;
  }

  const v = await redis<string | null>(["GET", DRAW_MARKER]);
  // If the marker key itself is missing despite the sentinel being set, that's a
  // data corruption scenario — throw rather than silently resetting.
  if (v == null) {
    throw new Error("Draw marker sentinel set but marker value missing — possible data loss");
  }
  return BigInt(v);
}

export async function setDrawMarker(drawingId: bigint) {
  await redis(["SET", DRAW_MARKER, drawingId.toString()]);
  // Mark as initialised so a future Redis hiccup doesn't look like first-run.
  await redis(["SET", MARKER_INITIALIZED, "1"]);
}

// ── Sender ───────────────────────────────────────────────────────────
// Groups tokens by their client `url` and batches ≤100 per request.
export async function sendNotifications(opts: {
  notificationId: string; // ≤128 chars, dedup key (per-fid on the client)
  title: string; // ≤32
  body: string; // ≤128
  targetUrl: string; // ≤1024, must be on the app's domain
  tokens: NotificationToken[];
}) {
  const byUrl = new Map<string, string[]>();
  for (const t of opts.tokens) {
    const list = byUrl.get(t.url) ?? [];
    list.push(t.token);
    byUrl.set(t.url, list);
  }

  const results: Array<{ url: string; sent: number; status?: number; error?: string }> = [];
  for (const [url, toks] of byUrl) {
    for (let i = 0; i < toks.length; i += 100) {
      const batch = toks.slice(i, i + 100);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            notificationId: opts.notificationId,
            title: opts.title,
            body: opts.body,
            targetUrl: opts.targetUrl,
            tokens: batch,
          }),
        });
        results.push({ url, sent: batch.length, status: res.status });
      } catch (err) {
        results.push({ url, sent: 0, error: String(err) });
      }
    }
  }
  return results;
}

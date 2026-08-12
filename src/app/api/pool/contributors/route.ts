// Contributor list for the pool's "who's in" row.
//
// The aggregate numbers on the Pool tab come from the CONTRACT, read client-side via wagmi
// (`poolOf` / `shareOf`) — cheap, authoritative, and always available. This route exists only
// to answer the one question the contract cannot: WHICH addresses are in, which needs the
// `Joined` (and `Sponsored`) logs.
//
// That split is the whole safety story. If this route fails, the tab degrades to numbers and
// hides the avatar row; it never renders a wrong list. So every failure path here returns
// `degraded: true` with empty lists rather than partial ones — for contributors AND sponsors.

import { NextResponse } from "next/server";
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import {
  FARPOT_POOL_ABI,
  FARPOT_POOL_ADDRESS,
  FARPOT_POOL_DEPLOY_BLOCK,
  JACKPOT_ABI,
  JACKPOT_ADDRESS,
} from "@/lib/constants";
import {
  acquireLock,
  addContributors,
  addContributorDrawings,
  addSponsors,
  getContributorDrawings,
  cacheEnabled,
  freezeDrawing,
  getContributors,
  getCursor,
  getSponsors,
  isFrozen,
  releaseLock,
  setCursor,
} from "@/lib/pool-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REVALIDATE_SECONDS = 30;

// Public Base RPCs cap `eth_getLogs` ranges; 10k is the documented safe chunk.
const CHUNK = BigInt(10_000);

// Only blocks this far behind the head advance the cursor, so a short reorg re-scans its
// range instead of baking an orphaned log into the cache.
const CONFIRMATIONS = BigInt(2);

// Ceiling on a single cold rebuild. Without a cache the scan starts at the deployment block
// every time, and that range grows forever — the exact unbounded-rescan problem the cursor
// exists to solve. Past this, serve numbers-only rather than hammer the RPC.
const MAX_COLD_BLOCKS = BigInt(500_000);

const JOINED_EVENT = FARPOT_POOL_ABI.find(
  (entry) => entry.type === "event" && entry.name === "Joined",
)!;

const SPONSORED_EVENT = FARPOT_POOL_ABI.find(
  (entry) => entry.type === "event" && entry.name === "Sponsored",
)!;

const client = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
});

interface Contributor {
  address: string;
  tickets: string;
  username: string | null;
  pfp: string | null;
}

interface NeynarBulkUser {
  username?: string;
  pfp_url?: string;
}

/**
 * Scan `Joined` and `Sponsored` logs from the cursor to the confirmed head, in ONE range walk.
 *
 * Both event classes are pulled via `events:` in the same `getLogs` call rather than two
 * independent scans — a second scan would need a second cursor and could not stay atomic with
 * the first, breaking the "cursor only advances over ranges fully processed" invariant.
 *
 * `Joined` logs feed both the forward (drawing → addresses) and reverse (address → drawings)
 * contributor indexes. `Sponsored` logs feed ONLY the sponsor set — never the reverse index —
 * so a sponsor-only drawing never offers a joiner claim path that correctly pays zero.
 */
async function scan(confirmedHead: bigint): Promise<void> {
  const cursor = await getCursor();
  let from = cursor === null ? FARPOT_POOL_DEPLOY_BLOCK : cursor + BigInt(1);

  if (cursor === null && confirmedHead - from > MAX_COLD_BLOCKS) {
    throw new Error(
      `cold rebuild would span ${confirmedHead - from} blocks (max ${MAX_COLD_BLOCKS})`,
    );
  }
  if (from > confirmedHead) return;

  while (from <= confirmedHead) {
    const to = from + CHUNK - BigInt(1) > confirmedHead ? confirmedHead : from + CHUNK - BigInt(1);
    const logs = await client.getLogs({
      address: FARPOT_POOL_ADDRESS,
      events: [JOINED_EVENT, SPONSORED_EVENT] as never,
      fromBlock: from,
      toBlock: to,
    });

    // Three indexes off one pass: drawing → joiner addresses (the "who's in" row), address →
    // drawings (the claim history), and drawing → sponsor addresses. Deriving all three here
    // means they cannot drift apart, and the extra indexes cost no extra RPC.
    const byDrawing = new Map<bigint, Set<string>>();
    const byAddress = new Map<string, Set<bigint>>();
    const sponsorsByDrawing = new Map<bigint, Set<string>>();
    for (const log of logs) {
      const eventName = (log as { eventName?: string }).eventName;
      if (eventName === "Joined") {
        const args = (log as { args?: { drawingId?: bigint; contributor?: string } }).args;
        if (args?.drawingId === undefined || !args.contributor) continue;
        const who = args.contributor.toLowerCase();
        const set = byDrawing.get(args.drawingId) ?? new Set<string>();
        set.add(who);
        byDrawing.set(args.drawingId, set);
        const drawings = byAddress.get(who) ?? new Set<bigint>();
        drawings.add(args.drawingId);
        byAddress.set(who, drawings);
      } else if (eventName === "Sponsored") {
        const args = (log as { args?: { drawingId?: bigint; sponsor?: string } }).args;
        if (args?.drawingId === undefined || !args.sponsor) continue;
        const who = args.sponsor.toLowerCase();
        const set = sponsorsByDrawing.get(args.drawingId) ?? new Set<string>();
        set.add(who);
        sponsorsByDrawing.set(args.drawingId, set);
      }
    }

    // All indexes FIRST, cursor LAST. A crash between them re-scans this chunk, which is
    // idempotent; the opposite order would skip it and lose those records for good.
    for (const [drawingId, addresses] of byDrawing) {
      await addContributors(drawingId, [...addresses]);
    }
    for (const [who, drawings] of byAddress) {
      await addContributorDrawings(who, [...drawings]);
    }
    for (const [drawingId, addresses] of sponsorsByDrawing) {
      await addSponsors(drawingId, [...addresses]);
    }
    await setCursor(to);

    from = to + BigInt(1);
  }
}

async function resolveIdentities(addresses: string[]): Promise<Map<string, NeynarBulkUser>> {
  const out = new Map<string, NeynarBulkUser>();
  const key = process.env.NEYNAR_API_KEY;
  if (!key || addresses.length === 0) return out;
  try {
    const res = await fetch(
      `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${addresses.slice(0, 50).join(",")}`,
      {
        headers: { accept: "application/json", "x-api-key": key },
        next: { revalidate: REVALIDATE_SECONDS },
      },
    );
    // A 404 means none of the addresses map to an account — the all-bare-wallets case, not
    // an error.
    if (!res.ok) return out;
    const byAddress = (await res.json()) as Record<string, NeynarBulkUser[] | undefined>;
    for (const address of addresses) {
      const user = byAddress[address]?.[0];
      // Neynar serves "!<fid>" placeholders for accounts with no registered fname; those are
      // unresolved, not usernames, and rendering one shows "@!862549".
      if (user?.username && !user.username.startsWith("!")) out.set(address, user);
    }
  } catch {
    /* identity resolution is decorative — bare wallets still render */
  }
  return out;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get("drawingId");
  const forAddress = url.searchParams.get("address");

  let drawingId: bigint;
  try {
    drawingId =
      requested !== null
        ? BigInt(requested)
        : await client.readContract({
            address: JACKPOT_ADDRESS,
            abi: JACKPOT_ABI,
            functionName: "currentDrawingId",
          });
  } catch (err) {
    console.error("[pool:contributors] cannot read the drawing id:", err);
    return degraded(BigInt(0));
  }

  if (!cacheEnabled) {
    // No Redis configured. Rather than scanning all history on every request, say so — the
    // client shows numbers only. This is a deployment gap, not a runtime error.
    console.warn("[pool:contributors] cache not configured — serving numbers-only");
    return degraded(drawingId);
  }

  let lockToken: string | null = null;
  try {
    const head = await client.getBlockNumber();
    const confirmedHead = head > CONFIRMATIONS ? head - CONFIRMATIONS : BigInt(0);

    // Is the cache COMPLETE enough to serve as authoritative? Serving an address list that
    // another instance is still mid-scan on would present a partial list as the whole truth,
    // and then cache it at the CDN — the same defect the failed-multicall check closes, coming
    // in through incomplete DISCOVERY rather than incomplete weights.
    let complete = false;

    // A frozen drawing's list is final, so skip the scan entirely and serve the cache.
    if (await isFrozen(drawingId)) {
      complete = true;
    } else {
      lockToken = await acquireLock();
      if (lockToken) {
        await scan(confirmedHead);

        // Freeze check — §5's three conditions, satisfied together.
        //
        // The drawing id is read AT `confirmedHead`, not at `latest`. That is what makes this
        // sound: if the id there is already past `drawingId`, the rollover happened at or
        // before `confirmedHead`, and the cursor now equals `confirmedHead`, so every block
        // in which a `Joined(drawingId, …)` could exist is behind the cursor. Reading at
        // `latest` would let a rollover in the last two (unconfirmed) blocks freeze a list
        // before its final joins were scanned, losing late joiners permanently.
        const idAtConfirmedHead = await client.readContract({
          address: JACKPOT_ADDRESS,
          abi: JACKPOT_ABI,
          functionName: "currentDrawingId",
          blockNumber: confirmedHead,
        });
        if (idAtConfirmedHead > drawingId) await freezeDrawing(drawingId);
        // We just scanned to confirmedHead ourselves, so the cache is current by construction.
        complete = true;
      } else {
        // Another instance holds the lock. Duplicating its scan would be waste, so instead ask
        // whether the cache is ALREADY current: if the cursor has reached this request's
        // confirmed head, whatever that instance is doing cannot add anything we would miss.
        // If it has not, the cache is mid-flight and must not be served as complete.
        const cursor = await getCursor();
        complete = cursor !== null && cursor >= confirmedHead;
      }
    }

    if (!complete) return degraded(drawingId);

    // Every drawing this wallet has joined, with no expiry window — a bounded look-back would
    // recreate the unreachable-claim defect on a delay, since claim() has no deadline on-chain.
    const yourDrawings = forAddress
      ? (await getContributorDrawings(forAddress)).map((d) => d.toString())
      : [];

    const addresses = await getContributors(drawingId);
    const sponsorAddresses = await getSponsors(drawingId);

    const contributors: Contributor[] = [];
    if (addresses.length > 0) {
      // Weights come from the CHAIN, never from the cache, so a displayed number cannot drift
      // from contract state no matter what the scan did.
      const weights = await client.multicall({
        contracts: addresses.map((address) => ({
          address: FARPOT_POOL_ADDRESS,
          abi: FARPOT_POOL_ABI,
          functionName: "shareOf" as const,
          args: [drawingId, address as Address],
        })),
        allowFailure: true,
      });

      // If ANY weight read failed, the list we could build is incomplete — and an incomplete
      // list is indistinguishable from a complete one to the user, who would see a real player
      // missing. Silently skipping the failures and returning degraded:false would also cache
      // that incomplete answer at the CDN for the revalidate window. Degrade instead: numbers
      // only, no faces, which is the invariant this route exists to hold. A failure here
      // degrades sponsors too — a partial list must never render, for either side.
      if (weights.some((w) => w?.status !== "success")) {
        console.error("[pool:contributors] weight read failed for at least one address");
        return degraded(drawingId);
      }

      const identities = await resolveIdentities(addresses);
      addresses.forEach((address, i) => {
        const result = weights[i];
        if (result?.status !== "success") return;
        const tickets = (result.result as readonly [bigint, bigint, boolean])[0];
        // A zero weight means this address never actually joined this drawing — a stale cache
        // entry. Drop it rather than render a contributor with no tickets.
        if (tickets === BigInt(0)) return;
        const user = identities.get(address);
        contributors.push({
          address,
          tickets: tickets.toString(),
          username: user?.username ?? null,
          pfp: user?.pfp_url ?? null,
        });
      });

      // Identified users first (a stable sort, so ticket order still holds within each group),
      // matching the ticker's convention — otherwise the avatars, which are the point of the
      // row, get pushed off the end by bare wallets that happen to hold more tickets.
      contributors.sort((a, b) => {
        const named = Number(Boolean(b.username)) - Number(Boolean(a.username));
        if (named !== 0) return named;
        return Number(BigInt(b.tickets) - BigInt(a.tickets));
      });
    }

    const sponsors: Contributor[] = [];
    if (sponsorAddresses.length > 0) {
      const sponsorWeights = await client.multicall({
        contracts: sponsorAddresses.map((address) => ({
          address: FARPOT_POOL_ADDRESS,
          abi: FARPOT_POOL_ABI,
          functionName: "sponsoredByUser" as const,
          args: [drawingId, address as Address],
        })),
        allowFailure: true,
      });

      // Same rule as the contributor weights: a partial sponsor list must never render.
      if (sponsorWeights.some((w) => w?.status !== "success")) {
        console.error("[pool:contributors] sponsor weight read failed for at least one address");
        return degraded(drawingId);
      }

      const sponsorIdentities = await resolveIdentities(sponsorAddresses);
      sponsorAddresses.forEach((address, i) => {
        const result = sponsorWeights[i];
        if (result?.status !== "success") return;
        const tickets = result.result as bigint;
        // A zero weight means this address never actually sponsored this drawing — a stale
        // cache entry. Drop it rather than render a sponsor with no tickets.
        if (tickets === BigInt(0)) return;
        const user = sponsorIdentities.get(address);
        sponsors.push({
          address,
          tickets: tickets.toString(),
          username: user?.username ?? null,
          pfp: user?.pfp_url ?? null,
        });
      });

      // Deliberately NOT sorted, unlike contributors: a later feature breaks a billing tie by
      // "earliest sponsor at the maximum weight", derived from the order this route returns.
      // (`sponsorAddresses` itself comes back from a Redis Set via `getSponsors`, which does not
      // guarantee insertion order — see pool-cache.ts. This preserves whatever order arrives
      // rather than compounding the loss with a second re-sort.)
    }

    return NextResponse.json(
      { drawingId: drawingId.toString(), contributors, sponsors, yourDrawings, degraded: false },
      { headers: { "cache-control": `s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate` } },
    );
  } catch (err) {
    console.error("[pool:contributors] scan failed:", err);
    return degraded(drawingId);
  } finally {
    if (lockToken) {
      try {
        await releaseLock(lockToken);
      } catch {
        /* the TTL frees it anyway */
      }
    }
  }
}

/** Numbers-only response: the client hides the avatar row and renders contract totals. */
function degraded(drawingId: bigint) {
  return NextResponse.json(
    {
      drawingId: drawingId.toString(),
      contributors: [],
      sponsors: [],
      yourDrawings: [],
      degraded: true,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

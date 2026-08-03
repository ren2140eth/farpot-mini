// Contributor list for the pool's "who's in" row.
//
// The aggregate numbers on the Pool tab come from the CONTRACT, read client-side via wagmi
// (`poolOf` / `shareOf`) — cheap, authoritative, and always available. This route exists only
// to answer the one question the contract cannot: WHICH addresses are in, which needs the
// `Joined` logs.
//
// That split is the whole safety story. If this route fails, the tab degrades to numbers and
// hides the avatar row; it never renders a wrong list. So every failure path here returns
// `degraded: true` with an empty list rather than a partial one.

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
  cacheEnabled,
  freezeDrawing,
  getContributors,
  getCursor,
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
 * Scan `Joined` logs from the cursor to the confirmed head, storing contributor addresses.
 *
 * Returns the drawing ids touched, so the caller knows what may now be freezable.
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
      event: JOINED_EVENT as never,
      fromBlock: from,
      toBlock: to,
    });

    // Group by drawing so each drawing takes one SADD.
    const byDrawing = new Map<bigint, Set<string>>();
    for (const log of logs) {
      const args = (log as { args?: { drawingId?: bigint; contributor?: string } }).args;
      if (args?.drawingId === undefined || !args.contributor) continue;
      const set = byDrawing.get(args.drawingId) ?? new Set<string>();
      set.add(args.contributor.toLowerCase());
      byDrawing.set(args.drawingId, set);
    }

    // Addresses FIRST, cursor LAST. A crash between them re-scans this chunk, which is
    // idempotent; the opposite order would skip it and lose those contributors for good.
    for (const [drawingId, addresses] of byDrawing) {
      await addContributors(drawingId, [...addresses]);
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

  let locked = false;
  try {
    const head = await client.getBlockNumber();
    const confirmedHead = head > CONFIRMATIONS ? head - CONFIRMATIONS : BigInt(0);

    // A frozen drawing's list is final, so skip the scan entirely and serve the cache.
    if (!(await isFrozen(drawingId))) {
      locked = await acquireLock();
      if (locked) {
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
      }
      // Not holding the lock is fine: another instance is scanning, and stale-by-one-poll is
      // a better answer than a duplicated scan against a rate-limited RPC.
    }

    const addresses = await getContributors(drawingId);
    if (addresses.length === 0) {
      return NextResponse.json(
        { drawingId: drawingId.toString(), contributors: [], degraded: false },
        { headers: { "cache-control": `s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate` } },
      );
    }

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

    const identities = await resolveIdentities(addresses);

    const contributors: Contributor[] = [];
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

    return NextResponse.json(
      { drawingId: drawingId.toString(), contributors, degraded: false },
      { headers: { "cache-control": `s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate` } },
    );
  } catch (err) {
    console.error("[pool:contributors] scan failed:", err);
    return degraded(drawingId);
  } finally {
    if (locked) {
      try {
        await releaseLock();
      } catch {
        /* the TTL frees it anyway */
      }
    }
  }
}

/** Numbers-only response: the client hides the avatar row and renders contract totals. */
function degraded(drawingId: bigint) {
  return NextResponse.json(
    { drawingId: drawingId.toString(), contributors: [], degraded: true },
    { headers: { "cache-control": "no-store" } },
  );
}

// Who, among the notification subscribers, had a stake in the POOL's tickets for a drawing.
//
// This is the one thing Megapot's round roster cannot answer. The pool contract OWNS every
// ticket it buys, so `/rounds/{id}/players` lists `FARPOT_POOL_ADDRESS` and nothing else about
// the group — a subscriber whose only play that day was joining a group buy read as a
// non-player, was sent the "you haven't played" nudge instead of their results, and was never
// told a share of a real pot was waiting behind a `claim()` only they can send.
//
// Read straight from the CHAIN rather than from the contributor cache (`pool-cache.ts`), even
// though that cache already holds a drawing → joiners index. Two reasons:
//
//   1. The cache is filled by the contributors ROUTE, which only runs when somebody opens the
//      Pool tab. A drawing nobody viewed has no entry, and an absent entry is indistinguishable
//      from "nobody joined" — so a quiet day would silently drop exactly the notification that
//      matters most.
//   2. We do not need the cache's hard question ("which addresses are in?"), only the easy one
//      ("is THIS address in?"), and `shareOf` answers that authoritatively in one multicall.
//
// Failure is reported as `null`, never as an empty set. An empty set means "checked, nobody" and
// lets the caller nudge those subscribers; null means "unknown", and the caller must park rather
// than misfile a real participant as someone who has not played in weeks.
import type { PublicClient } from "viem";

/**
 * Only the two methods this module calls. A bare `PublicClient` would NOT accept the cron's
 * chain-typed, `fallback`-transport client — viem's generics make the concrete client a
 * different (not merely narrower) type, and the mismatch surfaces on unrelated members like
 * `getBlock`. Structural typing keeps the caller free to pass whatever client it already has.
 */
type PoolReader = Pick<PublicClient, "readContract" | "multicall">;
import { FARPOT_POOL_ABI, FARPOT_POOL_ADDRESS } from "./constants";
import { poolParticipation } from "./notify-classify";

/** `poolOf`'s tuple, in declaration order — six flat ABI outputs, so viem returns an array. */
type PoolOfResult = readonly [bigint, bigint, bigint, number, bigint, bigint];

/**
 * The subset of `candidates` that has a stake in `drawingId`'s pool, lowercased.
 *
 * `candidates` are the subscribers' verified addresses, already lowercased. Returns null if any
 * read failed — a partial answer here is worse than none, because the addresses it omits are
 * exactly the participants who would then be classed as lapsed and nudged.
 */
export async function fetchPoolParticipants(
  client: PoolReader,
  drawingId: bigint,
  candidates: string[],
): Promise<Set<string> | null> {
  const out = new Set<string>();
  if (candidates.length === 0) return out;

  let joinerWeight: bigint;
  let ticketCount: bigint;
  try {
    const pool = (await client.readContract({
      address: FARPOT_POOL_ADDRESS,
      abi: FARPOT_POOL_ABI,
      functionName: "poolOf",
      args: [drawingId],
    })) as PoolOfResult;
    // Positional by necessity: `poolOf` declares six flat outputs, so a named read would be
    // `undefined` — the exact defect that once rendered the jackpot card as zeros.
    joinerWeight = pool[0];
    ticketCount = pool[5];
  } catch (err) {
    console.error("[notify:pool] poolOf failed for drawing", drawingId.toString(), err);
    return null;
  }

  // The pool bought nothing for this drawing, so there is no outcome to tell anyone about.
  // Short-circuits the common case — most drawings predate the pool or had no joiners — for
  // one RPC read rather than a multicall sized by the subscriber list.
  if (ticketCount === BigInt(0)) return out;

  const joined = await client.multicall({
    contracts: candidates.map((address) => ({
      address: FARPOT_POOL_ADDRESS,
      abi: FARPOT_POOL_ABI,
      functionName: "shareOf" as const,
      args: [drawingId, address as `0x${string}`],
    })),
    allowFailure: true,
  });
  if (joined.some((r) => r?.status !== "success")) {
    console.error("[notify:pool] shareOf multicall had failures for drawing", drawingId.toString());
    return null;
  }

  // Sponsored weight is only worth reading in the zero-joiner fallback — the ONLY case where
  // `sponsorShareOf` pays a sponsor anything. When joiners exist the pot is theirs, so a
  // sponsor has nothing riding on the result and must not be told to go and check.
  let sponsored: bigint[] | null = null;
  if (joinerWeight === BigInt(0)) {
    const res = await client.multicall({
      contracts: candidates.map((address) => ({
        address: FARPOT_POOL_ADDRESS,
        abi: FARPOT_POOL_ABI,
        functionName: "sponsoredByUser" as const,
        args: [drawingId, address as `0x${string}`],
      })),
      allowFailure: true,
    });
    if (res.some((r) => r?.status !== "success")) {
      console.error(
        "[notify:pool] sponsoredByUser multicall had failures for drawing",
        drawingId.toString(),
      );
      return null;
    }
    sponsored = res.map((r) => r.result as bigint);
  }

  candidates.forEach((address, i) => {
    const myJoined = (joined[i].result as readonly [bigint, bigint, boolean])[0];
    const mySponsored = sponsored?.[i] ?? BigInt(0);
    if (poolParticipation({ joinerWeight, ticketCount, myJoined, mySponsored })) {
      out.add(address);
    }
  });

  return out;
}

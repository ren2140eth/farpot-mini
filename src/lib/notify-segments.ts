// ──────────────────────────────────────────────────────────────────────
// Who gets which notification.
//
// The bug this replaces: `allTokenEntries()` is every fid that ever enabled notifications,
// and the cron sent ALL of them "Round #N results are live — tap to see if you won", once
// per settled round. Rounds settle daily, so a subscriber who had never bought a ticket got
// a daily push whose copy was simply false for them. Non-players now get a jackpot status
// message on a decaying throttle instead, and never the results line.
//
// Segmentation needs an address; the webhook only ever stores a fid. So the chain is
// fid → verified ETH address (Neynar) → did that address hold a ticket in the round (Megapot).
//
// THREE outcomes, not two. "Neynar says this fid has no verified address" and "the Neynar
// call failed" arrive at the same call site and mean opposite things:
//   • no verified address → they could not plausibly have bought → non-player
//   • lookup failed       → we do not know → send NOTHING this tick and re-evaluate next run
// Guessing "non-player" on a failure would both deny a real player their results and burn
// their nudge throttle on a message they did not need. Silence is the cheap mistake here;
// a wrong message costs a token we cannot get back without the user re-enabling by hand.
//
// Known gap, accepted: someone who buys from a wallet that is not one of their Farcaster
// verified addresses reads as a non-player. Closing it needs the client to register its
// connected address (Quick Auth); deliberately out of scope.
import { MEGAPOT_API_BASE } from "./constants";
import { getCachedAddresses, setCachedAddresses } from "./notifications";

import { roundPlayersUrl, parsePlayersPage, type PlayersPage } from "./notify-classify";

export { classify, nudgeDecision, NUDGE_LADDER_SECONDS } from "./notify-classify";
export type { SubscriberSegment, NudgeDecision } from "./notify-classify";

const PLAYERS_PAGE_LIMIT = 100;
// 50 pages × 100 = 5,000 players. A real round is a few hundred (round 149: 382), so the cap
// only trips on something anomalous — in which case we say "unknown" rather than silently
// treating a truncated roster as complete and misfiling real players as non-players.
const PLAYERS_MAX_PAGES = 50;

/**
 * Every wallet that held a ticket in `roundId`, lowercased.
 *
 * Returns null when the roster could not be built completely (upstream error, or the page
 * cap tripped). Null means "unknown" for EVERY subscriber, and the caller must not advance
 * the draw marker — a partial roster would quietly downgrade real players to non-players.
 *
 * This is one bounded fetch per round rather than one lookup per subscriber, so its cost does
 * not grow with the subscriber list. It also keys on the ticket HOLDER (`wallet`), not the
 * buyer, so someone who was gifted a ticket correctly counts as a player.
 *
 * The tickets endpoint is deliberately not used for this: `/wallets/{addr}/tickets` silently
 * IGNORES a `round_id` query param (verified — a bogus round_id still returns current-round
 * tickets), so filtering there would look like it worked and always match.
 */
export async function fetchRoundPlayers(roundId: bigint): Promise<Set<string> | null> {
  const wallets = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < PLAYERS_MAX_PAGES; page++) {
    const url = roundPlayersUrl(MEGAPOT_API_BASE, roundId, PLAYERS_PAGE_LIMIT, cursor);
    let body: PlayersPage;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        console.error("[notify:segments] players fetch failed", roundId.toString(), res.status);
        return null;
      }
      body = (await res.json()) as PlayersPage;
    } catch (err) {
      console.error("[notify:segments] players fetch threw", roundId.toString(), err);
      return null;
    }

    const page = parsePlayersPage(body);
    for (const w of page.wallets) wallets.add(w);

    cursor = page.cursor;
    if (!cursor || page.count === 0) return wallets;
  }

  console.error("[notify:segments] players roster exceeded page cap for round", roundId.toString());
  return null;
}

interface NeynarBulkResponse {
  users?: Array<{
    fid?: number;
    verified_addresses?: {
      eth_addresses?: string[];
      primary?: { eth_address?: string | null } | null;
    } | null;
  }>;
}

const NEYNAR_FIDS_PER_CALL = 100;

/**
 * fid → its verified ETH addresses, lowercased.
 *
 * A value of `null` means the lookup FAILED for that fid (network error, non-2xx, or the fid
 * missing from an otherwise-successful response) and the caller must treat it as unknown.
 * An empty array is a real answer: this account has no verified address.
 */
export async function resolveVerifiedAddresses(
  fids: number[],
): Promise<Map<number, string[] | null>> {
  const out = new Map<number, string[] | null>();
  if (fids.length === 0) return out;

  const key = process.env.NEYNAR_API_KEY;
  if (!key) {
    // No key = we cannot resolve anyone. Everyone is "unknown", so the cron stays silent
    // rather than falling back to the old blast-everyone behaviour.
    console.error("[notify:segments] NEYNAR_API_KEY unset — cannot segment");
    for (const fid of fids) out.set(fid, null);
    return out;
  }

  for (let i = 0; i < fids.length; i += NEYNAR_FIDS_PER_CALL) {
    const chunk = fids.slice(i, i + NEYNAR_FIDS_PER_CALL);
    try {
      const res = await fetch(
        `https://api.neynar.com/v2/farcaster/user/bulk?fids=${chunk.join(",")}`,
        { headers: { accept: "application/json", "x-api-key": key }, cache: "no-store" },
      );
      if (!res.ok) {
        console.error("[notify:segments] neynar bulk failed", res.status);
        for (const fid of chunk) out.set(fid, null);
        continue;
      }
      const body = (await res.json()) as NeynarBulkResponse;
      const seen = new Map<number, string[]>();
      for (const user of body.users ?? []) {
        if (typeof user.fid !== "number") continue;
        const addrs = new Set<string>();
        for (const a of user.verified_addresses?.eth_addresses ?? []) {
          if (a) addrs.add(a.toLowerCase());
        }
        const primary = user.verified_addresses?.primary?.eth_address;
        if (primary) addrs.add(primary.toLowerCase());
        seen.set(user.fid, [...addrs]);
      }
      // A fid the response omitted is NOT "no addresses" — the call may have partially
      // succeeded. Mark it unknown so we stay quiet instead of misfiling a real player.
      for (const fid of chunk) out.set(fid, seen.get(fid) ?? null);
    } catch (err) {
      console.error("[notify:segments] neynar bulk threw", err);
      for (const fid of chunk) out.set(fid, null);
    }
  }

  return out;
}


/**
 * Cache-first address resolution for a whole subscriber list.
 *
 * Failures are deliberately NOT cached: a cached failure would pin that subscriber to
 * "unknown" for a day over what may have been a one-second blip, silently costing them a
 * round of results. Successes (including the empty array) cache for a day.
 */
export async function loadAddressesForFids(
  fids: number[],
): Promise<Map<number, string[] | null>> {
  const out = new Map<number, string[] | null>();
  const missing: number[] = [];

  for (const fid of fids) {
    const cached = await getCachedAddresses(fid);
    if (cached !== null) out.set(fid, cached);
    else missing.push(fid);
  }

  if (missing.length > 0) {
    const fresh = await resolveVerifiedAddresses(missing);
    for (const [fid, addrs] of fresh) {
      out.set(fid, addrs);
      if (addrs !== null) await setCachedAddresses(fid, addrs);
    }
  }

  return out;
}

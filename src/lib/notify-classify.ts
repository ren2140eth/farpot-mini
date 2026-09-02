// Pure decision logic for the segmented notification cron.
//
// Deliberately a LEAF module — no imports, no I/O — so `scripts/notify-segments-proof.ts`
// can exercise the real functions directly rather than a copy of them. Everything that
// touches Redis, Neynar or Megapot lives in `notify-segments.ts` / `notifications.ts`.

export type SubscriberSegment = "player" | "non-player" | "unknown";

// Decay ladder. These are the waits BETWEEN consecutive nudges, not before the first one:
// the first nudge fires on the first tick a subscriber is eligible, so the total a subscriber
// can ever receive is one MORE than the number of waits here.
//
// Naming matters because the earlier `NUDGE_LADDER_SECONDS` read as "one rung per nudge",
// which it never was — the final rung's wait is claimed as a throttle TTL but there is
// nothing after it to gate, so with three rungs and a stop-at-three the last one was dead.
//
// As tuned: nudges at day 0, +3, +10, +24, then silence until they play again. Four nudges
// over 24 days. Playing clears the state, so anyone who engages starts over at the shortest
// wait rather than resuming at "we already gave up on this person".
export const NUDGE_WAITS_SECONDS = [3, 7, 14].map((days) => days * 86_400);

/** One more than the number of waits — the first nudge is not preceded by one. */
export const MAX_NUDGES = NUDGE_WAITS_SECONDS.length + 1;

// NOTE — do NOT add a "only nudge when the jackpot moved" gate. It sounds right and was in the
// original design, but the jackpot is LP-funded and near-flat: measured on-chain across
// drawings #139–#150 it moved ±0.2% per day and +1.1% total over eleven days. Any relative
// threshold worth writing would never fire and the nudge would be silent forever. The ladder
// is what keeps repetition down; the figure is news to someone who has not seen it, not a
// moving number to report.

/**
 * Classify one subscriber against a completed round's roster of ticket holders.
 *
 * `addresses` is the resolver's answer:
 *   • null → the lookup FAILED. We do not know, so the caller must send nothing this tick.
 *     Guessing "non-player" here would deny a real player their results AND burn their nudge
 *     throttle; guessing "player" would tell someone to check tickets they never bought.
 *   • []   → a real answer: this account has no verified ETH address, so it could not
 *     plausibly have bought a ticket. Non-player.
 */
export function classify(
  addresses: string[] | null,
  roster: ReadonlySet<string>,
): SubscriberSegment {
  if (addresses === null) return "unknown";
  if (addresses.length === 0) return "non-player";
  // Both sides are lowercased at their source; compare defensively anyway, since a single
  // checksummed address leaking in would silently misfile a real player as a non-player.
  return addresses.some((a) => roster.has(a.toLowerCase())) ? "player" : "non-player";
}

/**
 * Does this wallet have a stake in what the POOL's tickets did in `drawingId`?
 *
 * The gap this closes: the pool contract OWNS every ticket it buys, so Megapot's round roster
 * lists the POOL's address, never the people in it. A wallet whose only play that day was
 * joining a group buy therefore read as a non-player, got the "you haven't played" nudge
 * instead of its results, and was never told that a share of a real pot was sitting unclaimed
 * behind a `claim()` it has to send itself.
 *
 * Pure, and fed entirely from contract reads, so the rule can be asserted without a chain:
 *
 *   • `ticketCount === 0` — the pool bought nothing for this drawing. There is no outcome to
 *     report, whatever anyone's book-keeping says, so nobody is a participant.
 *   • `myJoined > 0` — a joiner is paid pro-rata out of the pot whenever the pool wins.
 *     Always a participant.
 *   • `mySponsored > 0` — a sponsor takes NO payout weight and is paid only in the zero-joiner
 *     fallback, which is why `joinerWeight === 0` gates it. The gate mirrors `sponsorShareOf`
 *     exactly. Without it, every sponsor of a draw other people joined would be told to go and
 *     see if they won, when the contract owes them nothing and the row will say so.
 */
export function poolParticipation(params: {
  /** `poolOf.tickets` — joiner weight for the whole drawing, excluding sponsored tickets. */
  joinerWeight: bigint;
  /** `poolOf.ticketCount` — every ticket the pool bought, joined and sponsored alike. */
  ticketCount: bigint;
  /** `shareOf(drawingId, who).tickets`. */
  myJoined: bigint;
  /** `sponsoredByUser(drawingId, who)`. */
  mySponsored: bigint;
}): boolean {
  const { joinerWeight, ticketCount, myJoined, mySponsored } = params;
  if (ticketCount === BigInt(0)) return false;
  if (myJoined > BigInt(0)) return true;
  return mySponsored > BigInt(0) && joinerWeight === BigInt(0);
}

/** Which of the two ways of playing put this subscriber in the results segment. */
export type PlayerRoute = "tickets" | "pool";

export type SegmentResult =
  | { segment: "unknown" }
  | { segment: "non-player" }
  | { segment: "player"; via: PlayerRoute };

/**
 * `classify`, widened to count a group buy as playing.
 *
 * `poolRoster` holds the subscriber addresses that `poolParticipation` accepted for this
 * drawing. It is deliberately a SECOND set rather than being unioned into `roster` upstream,
 * because the two routes land in different places: someone holding their own ticket is sent to
 * Results, where that ticket is; someone whose only stake is the group buy is sent to Pool,
 * where their claim is. Unioning would send the pool-only cohort to an empty ticket list —
 * a notification that says "tap to see if you won" and then shows nothing.
 *
 * Direct tickets win the tie. A subscriber in BOTH is sent to Results, which is the tab that
 * would otherwise be unreachable from the notification; the pool claim still announces itself
 * through the Pool tab's own nav badge.
 */
export function classifyWithPool(
  addresses: string[] | null,
  roster: ReadonlySet<string>,
  poolRoster: ReadonlySet<string>,
): SegmentResult {
  if (addresses === null) return { segment: "unknown" };
  if (addresses.length === 0) return { segment: "non-player" };
  const lower = addresses.map((a) => a.toLowerCase());
  if (lower.some((a) => roster.has(a))) return { segment: "player", via: "tickets" };
  if (lower.some((a) => poolRoster.has(a))) return { segment: "player", via: "pool" };
  return { segment: "non-player" };
}

export type NudgeDecision =
  | { send: false; reason: "ladder-exhausted" }
  | { send: true; ttlSeconds: number };

/** Given how many nudges this fid has already had, decide whether to send another. */
export function nudgeDecision(step: number): NudgeDecision {
  if (!Number.isFinite(step) || step < 0) step = 0;
  if (step >= MAX_NUDGES) return { send: false, reason: "ladder-exhausted" };
  // The throttle claimed after THIS send is the wait before the next one. The final nudge has
  // no next one, so its value is immaterial — reuse the last wait rather than read past the
  // end of the array, which would put `undefined` into a Redis EX and fail the claim.
  const ttlSeconds = NUDGE_WAITS_SECONDS[Math.min(step, NUDGE_WAITS_SECONDS.length - 1)];
  return { send: true, ttlSeconds };
}

// ── Round roster: URL + parsing ──────────────────────────────────────
// These are pure so the proof can exercise the REAL url shape and the REAL parser against a
// live response. Only the paging loop that calls them is impure (see `notify-segments.ts`).

export interface PlayersPage {
  data?: Array<{ wallet?: string }>;
  next_cursor?: string | null;
}

/**
 * NOTE: the roster comes from `/rounds/{id}/players`, NOT from `/wallets/{addr}/tickets`.
 * The tickets endpoint silently IGNORES a `round_id` query param — verified live, a bogus
 * round_id still returns current-round tickets — so filtering there would look like it
 * worked and match everybody.
 */
export function roundPlayersUrl(
  apiBase: string,
  roundId: bigint | string,
  limit: number,
  cursor?: string | null,
): string {
  return (
    `${apiBase}/rounds/${roundId}/players?limit=${limit}` +
    (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")
  );
}

/**
 * Wallets are lowercased HERE, at the single point of entry, because the roster is only ever
 * consumed as a Set membership test. One checksummed address surviving into that Set would
 * make a real player read as a non-player — silently, and only for that person.
 */
export function parsePlayersPage(body: PlayersPage): {
  wallets: string[];
  cursor: string | null;
  count: number;
} {
  const rows = body.data ?? [];
  const wallets: string[] = [];
  for (const row of rows) {
    if (row.wallet) wallets.push(row.wallet.toLowerCase());
  }
  return { wallets, cursor: body.next_cursor ?? null, count: rows.length };
}

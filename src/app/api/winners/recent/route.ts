// Recent-winners feed for the wins ticker — top wins from the latest settled
// rounds (Megapot Data API `GET /v1/rounds/{id}/wins`), with wallets resolved
// to Farcaster identities via Neynar bulk-by-address when possible. Identity
// resolution is decorative: winners without a Farcaster account (or when the
// key/lookup is unavailable) still ship as bare wallets and the client renders
// a shortened address.

import { NextResponse } from "next/server";
import { MEGAPOT_API_BASE } from "@/lib/constants";

export const runtime = "nodejs";
// The inner fetches carry their own 5-minute revalidate windows; keeping the
// route dynamic avoids baking build-time winner data into the page.
export const dynamic = "force-dynamic";

const REVALIDATE_SECONDS = 300;
const SETTLED_ROUNDS = 3;
const WINNERS_PER_ROUND = 4;

interface ApiAmount {
  amount: string;
  decimals: number;
}

interface ApiRoundLite {
  id: string;
  status: string;
}

interface ApiWin {
  wallet: string;
  round_id: string;
  amount: ApiAmount;
}

interface TickerWinner {
  round_id: string;
  wallet: string;
  username: string | null;
  pfp: string | null;
  amount: ApiAmount;
}

interface NeynarBulkUser {
  username?: string;
  pfp_url?: string;
}

export async function GET() {
  try {
    const roundsRes = await fetch(`${MEGAPOT_API_BASE}/rounds?limit=6`, {
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!roundsRes.ok) return NextResponse.json({ winners: [] });
    const rounds = (await roundsRes.json()) as { data?: ApiRoundLite[] };
    const settled = (rounds.data ?? [])
      .filter((round) => round.status === "settled")
      .slice(0, SETTLED_ROUNDS);

    const winners: TickerWinner[] = [];
    for (const round of settled) {
      const winsRes = await fetch(
        `${MEGAPOT_API_BASE}/rounds/${round.id}/wins?limit=8`,
        { next: { revalidate: REVALIDATE_SECONDS } },
      );
      if (!winsRes.ok) continue;
      const wins = (await winsRes.json()) as { data?: ApiWin[] };
      // Wins come sorted by amount, so first-seen keeps each wallet's biggest.
      const seen = new Set<string>();
      for (const win of wins.data ?? []) {
        const wallet = win.wallet?.toLowerCase();
        if (!wallet || !win.amount || seen.has(wallet)) continue;
        seen.add(wallet);
        winners.push({
          round_id: win.round_id,
          wallet,
          username: null,
          pfp: null,
          amount: win.amount,
        });
        if (seen.size >= WINNERS_PER_ROUND) break;
      }
    }

    const neynarKey = process.env.NEYNAR_API_KEY;
    if (neynarKey && winners.length > 0) {
      const addresses = [...new Set(winners.map((w) => w.wallet))].slice(0, 20);
      try {
        const res = await fetch(
          `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${addresses.join(",")}`,
          {
            headers: { accept: "application/json", "x-api-key": neynarKey },
            next: { revalidate: REVALIDATE_SECONDS },
          },
        );
        // Neynar 404s when none of the addresses map to an account — that's
        // the "all bare wallets" case, not an error.
        if (res.ok) {
          const byAddress = (await res.json()) as Record<
            string,
            NeynarBulkUser[] | undefined
          >;
          for (const winner of winners) {
            const user = byAddress[winner.wallet]?.[0];
            // Neynar serves "!<fid>" placeholders for accounts with no
            // registered fname — treat those as unresolved.
            if (user?.username && !user.username.startsWith("!")) {
              winner.username = user.username;
              winner.pfp = user.pfp_url ?? null;
            }
          }
        }
      } catch {
        /* identity lookup failed — addresses still render */
      }
    }

    return NextResponse.json(
      { winners },
      { headers: { "cache-control": `s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate` } },
    );
  } catch {
    return NextResponse.json({ winners: [] });
  }
}

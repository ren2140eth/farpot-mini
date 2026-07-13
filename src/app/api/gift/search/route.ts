// Gift recipient lookup — resolves an exact Farcaster @username via Neynar.
// POST with { query: string } → { results: [...] }
// Uses the FREE-tier `user/by_username` endpoint (fuzzy `user/search` is paid),
// so the query must be an exact handle. Returns 0 or 1 result with the
// recipient's verified ETH address so the frontend can enter gift mode.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface SearchRequest {
  query: string;
}

interface NeynarUser {
  fid: number;
  username?: string;
  verified_addresses?: {
    eth_addresses?: string[];
    primary?: {
      eth_address?: string | null;
    };
  };
}

interface NeynarUserResponse {
  user?: NeynarUser;
}

export async function POST(req: Request) {
  let body: SearchRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Normalize: drop a leading "@", trim, lowercase (handles are lowercase).
  const handle = (body.query ?? "").trim().replace(/^@/, "").toLowerCase();
  if (handle.length < 1) {
    return NextResponse.json({ error: "query too short" }, { status: 400 });
  }

  const neynarKey = process.env.NEYNAR_API_KEY;
  if (!neynarKey) {
    return NextResponse.json(
      { error: "neynar api key not configured" },
      { status: 500 },
    );
  }

  try {
    const res = await fetch(
      `https://api.neynar.com/v2/farcaster/user/by_username?username=${encodeURIComponent(handle)}`,
      {
        headers: {
          accept: "application/json",
          "x-api-key": neynarKey,
        },
      },
    );

    // 404 = valid handle, no such user; 400 = malformed handle. Either way
    // there's no recipient to gift to — surface as "no match", not an error.
    if (res.status === 404 || res.status === 400) {
      return NextResponse.json({ results: [] });
    }
    if (!res.ok) {
      return NextResponse.json(
        { error: `neynar lookup failed: ${res.status}` },
        { status: 502 },
      );
    }

    const data = (await res.json()) as NeynarUserResponse;
    const u = data.user;
    if (!u) {
      return NextResponse.json({ results: [] });
    }

    const verified =
      u.verified_addresses?.primary?.eth_address ??
      u.verified_addresses?.eth_addresses?.[0] ??
      null;

    return NextResponse.json({
      results: [
        {
          fid: u.fid,
          username: u.username ?? `fid-${u.fid}`,
          verified_address: verified,
        },
      ],
    });
  } catch {
    return NextResponse.json(
      { error: "neynar lookup error" },
      { status: 502 },
    );
  }
}

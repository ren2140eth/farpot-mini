// Farcaster mini-app webhook — receives notification-token lifecycle events.
//
// Declared to Farcaster via `miniapp.webhookUrl` in the manifest.
// Clients POST a JSON Farcaster Signature envelope: { header, payload, signature }
// (base64url). The header carries the user's `fid`; the payload carries the
// `event` + `notificationDetails` { token, url }.
//
// Signature is verified via @farcaster/miniapp-node + Neynar app-key resolver.
// Spec: https://miniapps.farcaster.xyz/docs/guides/notifications
import { NextResponse } from "next/server";
import { parseWebhookEvent, verifyAppKeyWithNeynar } from "@farcaster/miniapp-node";
import { saveToken, removeToken } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WebhookEnvelope {
  header: string;
  payload: string;
  signature: string;
}

export async function POST(req: Request) {
  let envelope: WebhookEnvelope;
  try {
    envelope = (await req.json()) as WebhookEnvelope;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Verify the Farcaster JFS signature + resolve app key via Neynar.
  let result;
  try {
    result = await parseWebhookEvent(envelope, verifyAppKeyWithNeynar);
  } catch {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const { fid, event } = result;

  switch (event.event) {
    case "miniapp_added":
    case "notifications_enabled": {
      const details = "notificationDetails" in event ? event.notificationDetails : undefined;
      if (details) await saveToken(fid, details);
      break;
    }
    case "miniapp_removed":
    case "notifications_disabled":
      await removeToken(fid);
      break;
  }

  return NextResponse.json({ ok: true });
}

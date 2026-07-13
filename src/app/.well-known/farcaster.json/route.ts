import { withValidManifest } from "@coinbase/onchainkit/minikit";
import { minikitConfig } from "@/lib/minikit.config";

export async function GET() {
  return Response.json(withValidManifest(minikitConfig));
}

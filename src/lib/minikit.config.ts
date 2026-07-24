const ROOT_URL =
  process.env.NEXT_PUBLIC_URL ||
  (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
  "http://localhost:3000";

/**
 * MiniApp manifest configuration.
 * @see {@link https://docs.base.org/mini-apps/features/manifest}
 */
export const minikitConfig = {
  // Signed for domain "farpot.vercel.app" by fid 17354 (key 0x3d61…4F46).
  // Hardcoded (public data) — NOT env vars: pasting a 65-byte sig into a
  // dashboard truncates it. Validated: sig recovers to the header key.
  // Re-generate via https://farcaster.xyz/~/developers if the domain changes.
  accountAssociation: {
    header:
      "eyJmaWQiOjE3MzU0LCJ0eXBlIjoiYXV0aCIsImtleSI6IjB4M2Q2MTU1NzZiYzE5MzY2MDRlMTk0RGM2NUM5QjNlQmEyNUE0NEY0NiJ9",
    payload: "eyJkb21haW4iOiJmYXJwb3QudmVyY2VsLmFwcCJ9",
    signature:
      "LZ7AtiH9XbjpWY0ilydECsrbU2RAjLiVpbgsO3wjEfB3AZlBltuA992Tf4CnQ5V1b2Gn5IMozo/W5G8Dbt6WeBw=",
  },
  miniapp: {
    version: "1",
    name: "Farpot",
    subtitle: "Gift lottery tickets on Base",
    description:
      "Gift and buy lottery tickets on Base, powered by Megapot. 1 USDC per ticket, daily drawings, real prizes.",
    screenshotUrls: [`${ROOT_URL}/screenshot-v4.png`],
    iconUrl: `${ROOT_URL}/icon-v11.png`,
    // Versioned filename: Farcaster's image proxy caches by URL for a year, so a
    // fresh name is the only reliable way to ship a changed splash.
    // Regenerate with `node scripts/make-splash.mjs` (derives it from the icon).
    splashImageUrl: `${ROOT_URL}/splash-v10.png`,
    // The icon's own ground, so the splash art blends into its launch field.
    // Re-sample from the icon (scripts/make-splash.mjs GROUND) if the icon changes.
    splashBackgroundColor: "#faf9f3",
    homeUrl: ROOT_URL,
    primaryCategory: "finance",
    tags: ["farpot", "gift", "lottery", "megapot", "base"],
    heroImageUrl: `${ROOT_URL}/hero-v7.png`,
    tagline: "Gift a Base lottery ticket",
    ogTitle: "Farpot — powered by Megapot",
    ogDescription:
      "Buy lottery tickets on Base. Daily drawings, real prizes, provably fair.",
    ogImageUrl: `${ROOT_URL}/hero-v7.png`,
    webhookUrl: `${ROOT_URL}/api/webhook`,
  },
} as const;

// Derives the Farcaster launch splash from the app icon, so the two can never
// drift apart. Trims the icon down to its F★P mark, scales the mark to FILL of
// the canvas width, and re-centres it on the icon's own ground colour.
//
// The icon frames its mark small (~74% width) because app icons get rounded and
// masked by the OS; the splash has no mask, so that framing just reads as dead
// space on the launch screen. FILL buys back the difference.
//
// Run: node scripts/make-splash.mjs
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Keep in sync with minikit.config.ts splashBackgroundColor — a mismatch shows
// as a visible plate around the mark on the launch screen.
const GROUND = "#faf9f3";
const ICON = join(ROOT, "public", "icon-v11.png");
const OUT = join(ROOT, "public", "splash-v10.png");

// The manifest spec requires the splash to be exactly 200x200.
const CANVAS = 200;
// Mark width as a fraction of the canvas. 0.94 collides with the edges; 0.88
// reads large while keeping a margin on the P's shoulder.
const FILL = 0.88;

const mark = await sharp(ICON)
  .trim({ background: GROUND, threshold: 10 })
  .toBuffer();
const { width, height } = await sharp(mark).metadata();

const markWidth = Math.round(CANVAS * FILL);
const markHeight = Math.round((markWidth * height) / width);
const scaled = await sharp(mark).resize(markWidth, markHeight).toBuffer();

await sharp({
  create: {
    width: CANVAS,
    height: CANVAS,
    channels: 4,
    background: GROUND,
  },
})
  .composite([{ input: scaled, gravity: "centre" }])
  .png()
  .toFile(OUT);

console.log(
  `✓ splash-v10.png  ${CANVAS}x${CANVAS}  mark ${markWidth}x${markHeight} ` +
    `(${Math.round(FILL * 100)}% width, trimmed from ${width}x${height})`,
);

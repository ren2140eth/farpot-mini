// Generates the Farpot brand assets (icon / splash / hero / screenshot /
// favicon) as PNGs from inline SVG, using sharp.
// Direction-B palette: Farcaster-purple navy + gold. Icon/splash/favicon are a
// clean gold "F" monogram; the hero is the FAR⭐POT wordmark on a clean bg
// (no scattered balls / stripes).
// Run: node scripts/build-assets.mjs
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public");
const navy = { r: 0x0d, g: 0x09, b: 0x16 }; // #0d0916 (navy-deep) for flatten

// ── Shared defs (purple bg glow + brand gold) ─────────────────────────
const DEFS = `
  <radialGradient id="bg" cx="50%" cy="30%" r="92%">
    <stop offset="0%" stop-color="#4a2f78"/>
    <stop offset="48%" stop-color="#241833"/>
    <stop offset="100%" stop-color="#0d0916"/>
  </radialGradient>
  <radialGradient id="ball" cx="36%" cy="30%" r="78%">
    <stop offset="0%" stop-color="#FFF3C4"/>
    <stop offset="34%" stop-color="#FFCE2E"/>
    <stop offset="68%" stop-color="#F5A623"/>
    <stop offset="100%" stop-color="#A9660A"/>
  </radialGradient>
  <linearGradient id="goldText" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#FFE9A8"/>
    <stop offset="46%" stop-color="#FFCE2E"/>
    <stop offset="58%" stop-color="#F5A623"/>
    <stop offset="100%" stop-color="#C5840E"/>
  </linearGradient>
  <linearGradient id="white" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#FFFFFF"/>
    <stop offset="100%" stop-color="#EADEF7"/>
  </linearGradient>
  <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
    <feDropShadow dx="0" dy="0" stdDeviation="16" flood-color="#FFC94D" flood-opacity="0.5"/>
  </filter>
  <filter id="softshadow" x="-30%" y="-30%" width="160%" height="160%">
    <feDropShadow dx="0" dy="8" stdDeviation="9" flood-color="#000000" flood-opacity="0.45"/>
  </filter>`;

// 5-point star path centred at (cx,cy)
function starPath(cx, cy, outer, inner) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? outer : inner;
    pts.push(`${(cx + rad * Math.cos(ang)).toFixed(1)},${(cy + rad * Math.sin(ang)).toFixed(1)}`);
  }
  return "M" + pts.join(" L") + "Z";
}

// glossy gold jackpot star-ball
const starBall = (cx, cy, r) => `
  <g filter="url(#glow)">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#ball)" stroke="#7A4A06" stroke-width="${r * 0.05}"/>
    <ellipse cx="${cx - r * 0.28}" cy="${cy - r * 0.34}" rx="${r * 0.4}" ry="${r * 0.28}" fill="#FFFFFF" opacity="0.5"/>
    <path d="${starPath(cx, cy, r * 0.62, r * 0.26)}" fill="#FFFFFF" opacity="0.92"/>
  </g>`;

// clean blocky "F" monogram, height h, centred on (cx,cy)
function fMark(cx, cy, h, { glow = true } = {}) {
  const w = 0.64 * h, stem = 0.23 * h, bar = 0.19 * h, midW = 0.80 * w;
  const left = cx - w / 2 - w * 0.03; // optical nudge left (F is stem-heavy)
  const top = cy - h / 2;
  const x1 = left + stem;
  const yTopBar = top + bar;
  const yMid0 = top + 0.42 * h, yMid1 = yMid0 + bar;
  const yBot = top + h;
  const d = `M${left},${top} L${left + w},${top} L${left + w},${yTopBar} ` +
    `L${x1},${yTopBar} L${x1},${yMid0} L${left + midW},${yMid0} ` +
    `L${left + midW},${yMid1} L${x1},${yMid1} L${x1},${yBot} L${left},${yBot} Z`;
  const path = `<path d="${d}" fill="url(#goldText)" stroke="#5a3f8a" stroke-width="${h * 0.012}" stroke-linejoin="round" filter="url(#softshadow)"/>`;
  return glow ? `<g filter="url(#glow)">${path}</g>` : path;
}

const text = (x, y, size, fill, str, anchor = "middle", spacing = 0) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="DejaVu Sans" font-weight="bold" font-size="${size}" letter-spacing="${spacing}" fill="${fill}" stroke="#2a1b3d" stroke-width="${size * 0.012}" filter="url(#softshadow)">${str}</text>`;

const svgDoc = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${DEFS}</defs><rect width="${w}" height="${h}" fill="url(#bg)"/>${body}</svg>`;

// horizontal FAR ⭐ POT lockup centred on (cx, baseline) with ball radius br
const lockup = (cx, baseline, fs, br) => {
  const gap = br + fs * 0.12;
  return `
    ${text(cx - gap, baseline, fs, "url(#white)", "FAR", "end")}
    ${starBall(cx, baseline - fs * 0.34, br)}
    ${text(cx + gap, baseline, fs, "url(#goldText)", "POT", "start")}`;
};

// ── Asset bodies ─────────────────────────────────────────────────────
// Icon: clean gold F on the purple bg — no rings, no ball.
const iconSvg = svgDoc(1024, 1024, fMark(512, 512, 560));

// Splash: same clean F, small.
const splashSvg = svgDoc(200, 200, fMark(100, 100, 118, { glow: false }));

// Hero 1200×800 (true 3:2, the aspect Farcaster renders cast embeds at).
// Just the wordmark + tagline on a clean bg — scattered balls / stripes removed.
const heroSvg = svgDoc(1200, 800, `
  ${lockup(600, 400, 140, 74)}
  ${text(600, 520, 40, "#FFFFFF", "DAILY ONCHAIN JACKPOT", "middle", 8)}
  ${text(600, 580, 28, "#a895c4", "1 USDC a ticket · on Base · via Farcaster", "middle", 2)}`);

// portrait promo "screenshot"
const W = 1284, H = 2778;
const numBall = (cx, cy, r, n, gold = false) => `
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${gold ? "url(#ball)" : "url(#white)"}" stroke="${gold ? "#7A4A06" : "#c8bce0"}" stroke-width="3"/>
  <ellipse cx="${cx - r * 0.28}" cy="${cy - r * 0.34}" rx="${r * 0.4}" ry="${r * 0.28}" fill="#FFFFFF" opacity="0.55"/>
  ${gold ? `<path d="${starPath(cx, cy, r * 0.5, r * 0.21)}" fill="#FFFFFF" opacity="0.5"/>` : ""}
  <text x="${cx}" y="${cy + r * 0.36}" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="${r * 0.95}" fill="${gold ? "#1a1206" : "#2a1b3d"}">${n}</text>`;
const ballRow = [7, 12, 23, 31, 44].map((n, i) => numBall(232 + i * 192, 1880, 76, n)).join("") + numBall(232 + 5 * 192, 1880, 76, 9, true);
const screenshotSvg = svgDoc(W, H, `
  ${lockup(642, 560, 150, 80)}
  ${text(642, 1180, 50, "#a895c4", "TODAY'S JACKPOT", "middle", 8)}
  ${text(642, 1400, 200, "url(#goldText)", "$1,105,356", "middle", 0)}
  ${text(642, 1600, 50, "#FFFFFF", "Pick 5 numbers + 1 bonus ball", "middle", 0)}
  ${ballRow}
  <rect x="222" y="2120" width="840" height="170" rx="85" fill="url(#goldText)"/>
  ${text(642, 2230, 60, "#1a1206", "BUY A TICKET · 1 USDC", "middle", 2).replace('filter="url(#softshadow)"', "")}
  ${text(642, 2470, 44, "#8b7aa8", "Daily drawings · Real prizes · On Base", "middle", 3)}`);

// ── Render ───────────────────────────────────────────────────────────
// icon/hero use versioned names: Farcaster's image CDN caches by URL, so a
// fresh URL is the only reliable way to bust a stale icon/embed after a rebrand.
const jobs = [
  ["icon-v4.png", iconSvg, true],
  ["splash-v2.png", splashSvg, true],
  ["hero-v4.png", heroSvg, false],
  ["screenshot.png", screenshotSvg, false],
];
for (const [name, svg, flatten] of jobs) {
  let img = sharp(Buffer.from(svg));
  if (flatten) img = img.flatten({ background: navy });
  await img.png().toFile(join(OUT, name));
  const meta = await sharp(join(OUT, name)).metadata();
  console.log(`✓ ${name.padEnd(16)} ${meta.width}x${meta.height}`);
}

// icon.png — Next.js app-router convention: serves as /icon?<content-hash> which
// auto-busts CDN cache when file changes (unlike favicon.ico which has no hash).
// See: next/dist/docs/.../app-icons.md — icon.png → <link rel="icon" href="/icon?<generated>" />
const faviconSvg = svgDoc(256, 256, fMark(128, 128, 150, { glow: false }));
await sharp(Buffer.from(faviconSvg)).resize(256, 256).ensureAlpha().png().toFile(join(ROOT, "src", "app", "icon.png"));
console.log(`✓ ${"icon.png".padEnd(16)} 256x256 (png, cache-busted by Next.js)`);

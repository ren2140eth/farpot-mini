import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Square on purpose: Farcaster feed tiles size themselves from the image's
// natural aspect ratio and clamp width (402px on web, left-anchored crop).
// A 1.91:1 card gets its right edge cut; a square card renders uncropped.
const SIZE = { width: 800, height: 800 };

const STAR_PATH =
  "M12 1.6l2.7 6.9 7.3.5-5.6 4.7 1.8 7.1L12 16.8l-6.2 4 1.8-7.1L2 9l7.3-.5z";

// Loaded once per instance; process.cwd() is the Next.js project directory.
let assetsPromise: Promise<{
  wordmark: string;
  anton: Buffer;
  archivoBold: Buffer;
  archivoExtraBold: Buffer;
}> | null = null;

function loadAssets() {
  assetsPromise ??= (async () => {
    const [wordmarkPng, anton, archivoBold, archivoExtraBold] =
      await Promise.all([
        readFile(join(process.cwd(), "assets/wordmark-transparent.png")),
        readFile(join(process.cwd(), "assets/Anton-Regular-subset.ttf")),
        readFile(join(process.cwd(), "assets/Archivo-Bold-subset.ttf")),
        readFile(join(process.cwd(), "assets/Archivo-ExtraBold-subset.ttf")),
      ]);
    return {
      wordmark: `data:image/png;base64,${wordmarkPng.toString("base64")}`,
      anton,
      archivoBold,
      archivoExtraBold,
    };
  })();
  return assetsPromise;
}

function safeText(value: string | null, fallback: string, maxLength: number) {
  const cleaned = value?.replace(/[^a-zA-Z0-9.,#$ ]/g, "").slice(0, maxLength);
  return cleaned || fallback;
}

function Star({
  size,
  fill,
  opacity,
  ...pos
}: {
  size: number;
  fill: string;
  opacity: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}) {
  return (
    <div style={{ position: "absolute", display: "flex", opacity, ...pos }}>
      <svg width={size} height={size} viewBox="0 0 24 24">
        <path d={STAR_PATH} fill={fill} />
      </svg>
    </div>
  );
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const amount = safeText(params.get("amount"), "0", 18);
  const winningTickets = Math.max(1, Math.min(99, Number(params.get("won")) || 1));
  const totalTickets = Math.max(
    winningTickets,
    Math.min(99, Number(params.get("tickets")) || winningTickets),
  );

  const { wordmark, anton, archivoBold, archivoExtraBold } = await loadAssets();

  // "$2" renders at 230px; long amounts shrink to stay inside the 720px
  // content width (Anton digits are ~0.58em wide).
  const amountText = `$${amount}`;
  const amountSize = Math.max(
    92,
    Math.min(230, Math.floor(720 / (0.58 * amountText.length))),
  );

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "64px 40px 56px",
        background:
          "radial-gradient(circle at 50% 12%, #35205a 0%, #241542 55%, #170e2b 100%)",
      }}
    >
      <Star size={44} fill="#f5c525" opacity={0.85} left={70} top={150} />
      <Star size={26} fill="#f5c525" opacity={0.55} right={88} top={210} />
      <Star size={30} fill="#cdb5f5" opacity={0.5} left={120} bottom={150} />
      <Star size={48} fill="#f5c525" opacity={0.9} right={64} bottom={196} />

      {/* eslint-disable-next-line @next/next/no-img-element -- satori JSX, not the DOM */}
      <img src={wordmark} width={430} height={81} alt="" />

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <span
          style={{
            fontFamily: "Archivo",
            fontWeight: 800,
            fontSize: 32,
            letterSpacing: 9.6,
            color: "#f5c525",
          }}
        >
          I JUST WON
        </span>
        <span
          style={{
            fontFamily: "Anton",
            fontSize: amountSize,
            lineHeight: 1.05,
            color: "#fdf8ec",
            marginTop: 4,
            textShadow: "0 0 60px rgba(245,197,37,.6)",
          }}
        >
          {amountText}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span
          style={{
            fontFamily: "Archivo",
            fontWeight: 800,
            fontSize: 30,
            letterSpacing: 1.2,
            color: "#f3eee4",
          }}
        >
          {winningTickets} WINNING TICKET{winningTickets === 1 ? "" : "S"}
          {totalTickets > winningTickets ? ` OUT OF ${totalTickets}` : ""}
        </span>
        <span
          style={{
            fontFamily: "Archivo",
            fontWeight: 700,
            fontSize: 20,
            letterSpacing: 2.4,
            color: "#cdb5f5",
          }}
        >
          CLAIMED ON BASE · PLAY ON FARPOT
        </span>
      </div>
    </div>,
    {
      ...SIZE,
      fonts: [
        { name: "Anton", data: anton, style: "normal", weight: 400 },
        { name: "Archivo", data: archivoBold, style: "normal", weight: 700 },
        { name: "Archivo", data: archivoExtraBold, style: "normal", weight: 800 },
      ],
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    },
  );
}

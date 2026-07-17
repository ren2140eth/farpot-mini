import { ImageResponse } from "next/og";

const SIZE = { width: 1200, height: 630 };

function safeText(value: string | null, fallback: string, maxLength: number) {
  const cleaned = value?.replace(/[^a-zA-Z0-9.,#$ ]/g, "").slice(0, maxLength);
  return cleaned || fallback;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const amount = safeText(params.get("amount"), "0", 18);
  const winningTickets = Math.max(1, Math.min(99, Number(params.get("won")) || 1));
  const totalTickets = Math.max(
    winningTickets,
    Math.min(99, Number(params.get("tickets")) || winningTickets),
  );
  const wordmarkUrl = new URL("/wordmark-v1.png", request.url).toString();
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "36px 58px 34px",
        background: "#fbf7ec",
        color: "#34204f",
        border: "18px solid #fbf7ec",
        boxShadow: "inset 0 0 0 3px #513269",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ width: 300, height: 110, display: "flex", position: "relative", alignItems: "center", justifyContent: "center" }}>
          <svg width="190" height="110" viewBox="0 0 190 110" style={{ position: "absolute" }}>
            <path d="M 18 27 Q 95 -7 172 27" fill="none" stroke="#f05b3d" strokeWidth="5" />
            <path d="M 18 83 Q 95 117 172 83" fill="none" stroke="#7547d5" strokeWidth="5" />
          </svg>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={wordmarkUrl} alt="Farpot" width={280} height={75} />
        </div>
        <div style={{ color: "#16875f", fontSize: 23, fontWeight: 800 }}>CLAIMED ON BASE</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
        <span style={{ color: "#7653a8", fontSize: 39, fontWeight: 800 }}>
          {winningTickets} WINNING TICKET{winningTickets === 1 ? "" : "S"} OUT OF {totalTickets}
        </span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 25 }}>
          <span style={{ fontSize: 76, fontWeight: 900 }}>I WON</span>
          <span style={{ fontSize: 118, fontWeight: 900, letterSpacing: -5 }}>${amount}</span>
        </div>
        <span style={{ color: "#16875f", fontSize: 34, fontWeight: 900 }}>USDC</span>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", borderTop: "2px dashed #7653a8", paddingTop: 18, fontSize: 23, fontWeight: 800 }}>
        <span style={{ color: "#855dcd" }}>PLAY ON FARPOT</span>
      </div>
    </div>,
    {
      ...SIZE,
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    },
  );
}

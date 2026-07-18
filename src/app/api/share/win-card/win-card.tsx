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

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f3eae8",
        color: "#34204f",
        fontFamily: "Arial, sans-serif",
      }}
    >
      {/* Farcaster crops wide images in-feed. Every meaningful element stays
          inside this centered 760px safe area; the outer space is decorative. */}
      <div
        style={{
          width: 760,
          height: 560,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "34px 24px 30px",
          background: "#fbf7ec",
          border: "3px solid #513269",
          borderRadius: 28,
          boxShadow: "0 14px 36px rgba(52,32,79,.15)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", fontSize: 43, fontWeight: 900 }}>
          <span style={{ color: "#f06a4f" }}>FAR</span>
          <span style={{ color: "#f5c525", margin: "0 8px" }}>•</span>
          <span style={{ color: "#855dcd" }}>POT</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <span style={{ color: "#7653a8", fontSize: 32, fontWeight: 900, letterSpacing: 2 }}>
            I JUST WON
          </span>
          <span
            style={{
              fontSize: amount.length > 9 ? 92 : 116,
              fontWeight: 900,
              letterSpacing: -4,
              lineHeight: 1.05,
            }}
          >
            ${amount}
          </span>
          <span style={{ color: "#16875f", fontSize: 36, fontWeight: 900 }}>USDC</span>
        </div>

        <div
          style={{
            width: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            borderTop: "2px dashed #a790bd",
            paddingTop: 20,
          }}
        >
          <span style={{ fontSize: 27, fontWeight: 900 }}>
            {winningTickets} WINNING TICKET{winningTickets === 1 ? "" : "S"}
            {totalTickets > winningTickets ? ` OUT OF ${totalTickets}` : ""}
          </span>
          <span style={{ color: "#855dcd", fontSize: 20, fontWeight: 800, marginTop: 8 }}>
            CLAIMED ON BASE · PLAY ON FARPOT
          </span>
        </div>
      </div>
    </div>,
    {
      ...SIZE,
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    },
  );
}

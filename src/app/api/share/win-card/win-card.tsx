import { ImageResponse } from "next/og";

const SIZE = { width: 1200, height: 630 };

function safeText(value: string | null, fallback: string, maxLength: number) {
  const cleaned = value?.replace(/[^a-zA-Z0-9.,#$ ]/g, "").slice(0, maxLength);
  return cleaned || fallback;
}

function Ball({ value, bonus = false }: { value: string; bonus?: boolean }) {
  return (
    <div
      style={{
        width: bonus ? 112 : 100,
        height: bonus ? 112 : 100,
        borderRadius: 999,
        border: bonus ? "4px solid #c18a00" : "3px solid #7653a8",
        background: bonus ? "linear-gradient(145deg, #ffe476, #f5c525)" : "#fffdf7",
        color: "#34204f",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: bonus ? 48 : 43,
        fontWeight: 900,
        boxShadow: bonus ? "0 8px 20px rgba(219,169,20,.3)" : "none",
      }}
    >
      {value.padStart(2, "0")}
    </div>
  );
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const amount = safeText(params.get("amount"), "0.00", 18);
  const round = safeText(params.get("round"), "—", 12);
  const normals = (params.get("normals") ?? "")
    .split(",")
    .map((number) => safeText(number, "--", 2))
    .slice(0, 5);
  while (normals.length < 5) normals.push("--");
  const bonus = safeText(params.get("bonus"), "--", 2);
  const bonusHit = params.get("bonusHit") === "1";
  const ticketCount = Math.max(1, Math.min(99, Number(params.get("tickets")) || 1));

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "46px 58px 30px",
        background: "#fbf7ec",
        color: "#34204f",
        border: "18px solid #fbf7ec",
        boxShadow: "inset 0 0 0 3px #513269",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", fontSize: 42, fontWeight: 900 }}>
          <span style={{ color: "#f06a4f" }}>FAR</span>
          <span style={{ color: "#f5c525", margin: "0 7px" }}>•</span>
          <span style={{ color: "#855dcd" }}>POT</span>
        </div>
        <div style={{ color: "#16875f", fontSize: 23, fontWeight: 800 }}>CLAIMED ON BASE</div>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 28 }}>
        <span style={{ fontSize: 76, fontWeight: 900 }}>I WON</span>
        <span style={{ fontSize: 118, fontWeight: 900, letterSpacing: -5 }}>${amount} USDC</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 22 }}>
        {normals.map((number, index) => <Ball key={`${number}-${index}`} value={number} />)}
        <span style={{ fontSize: 50, fontWeight: 700 }}>+</span>
        <Ball value={bonus} bonus />
        {bonusHit && <span style={{ fontSize: 22, fontWeight: 900, color: "#76500a" }}>BONUS HIT</span>}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", borderTop: "2px dashed #7653a8", paddingTop: 18, fontSize: 23, fontWeight: 800 }}>
        <span>ROUND #{round}</span>
        <span>{ticketCount} WINNING TICKET{ticketCount === 1 ? "" : "S"}</span>
        <span style={{ color: "#855dcd" }}>PLAY ON FARPOT</span>
      </div>
    </div>,
    {
      ...SIZE,
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    },
  );
}

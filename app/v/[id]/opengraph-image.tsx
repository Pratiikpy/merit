import { ImageResponse } from "next/og";
import { getCard, refreshCardsFromMirror } from "@/lib/cards";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Merit proof-of-citation receipt";

// The tweetable card: a big VERIFIED ✓ / REFUSED ✗ stamp + the claim, so a receipt link unfurls into a
// shareable trust (or gotcha) artifact on Twitter/LinkedIn/Slack.
export default async function OG({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await refreshCardsFromMirror().catch(() => {});
  const c = getCard(id);
  const sup = c?.verdict === "SUPPORTED";
  const claim = c ? (c.claim.length > 165 ? c.claim.slice(0, 165) + "…" : c.claim) : "Proof-of-citation receipt";
  const INK = "#0A0A0A", GREEN = "#047857", RED = "#BE123C", MUTED = "#6B7280";
  const accent = c ? (sup ? GREEN : RED) : INK;
  // Only claim "settled on Arc" when a real on-chain settlement actually happened. A free-verify, refused,
  // paused, stub, or custody-accrual card moved no on-chain USDC — the viral share image must not imply it did.
  const paidOnchain = !!(c && typeof c.paidUsdc === "number" && c.paidUsdc > 0 && !c.custody);
  const footerRight = paidOnchain
    ? `$${(c!.paidUsdc as number).toFixed(4)} settled on Arc`
    : c && c.custody
      ? "accrued to creator custody"
      : "proof-of-citation";

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#FFFFFF", padding: "64px 72px", justifyContent: "space-between" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 52, height: 52, borderRadius: 13, background: INK, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6.5 17 L6.5 7.5 L12 14 L17.5 7.5 L17.5 17" /><path d="M14.7 10.1 L17.5 7 L17.5 9.8" /></svg>
          </div>
          <div style={{ fontSize: 34, fontWeight: 800, color: INK, letterSpacing: "-1px" }}>Merit</div>
          <div style={{ fontSize: 22, color: MUTED, marginLeft: 8 }}>proof-of-citation receipt</div>
        </div>

        {/* verdict + claim */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 24 }}>
            <div style={{ width: 76, height: 76, borderRadius: 20, background: accent, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 46, fontWeight: 700 }}>{c ? (sup ? "✓" : "✕") : "•"}</div>
            <div style={{ fontSize: 68, fontWeight: 800, color: accent, letterSpacing: "-2px" }}>{c ? (sup ? "SUPPORTED" : "REFUSED") : "MERIT"}</div>
          </div>
          <div style={{ display: "flex", fontSize: 34, lineHeight: 1.3, color: INK, fontWeight: 600, borderLeft: `6px solid ${INK}`, paddingLeft: 22 }}>{claim}</div>
        </div>

        {/* footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", fontSize: 22, color: MUTED }}>Three gates: numeric · factual-consistency · adversarial judge</div>
          <div style={{ display: "flex", fontSize: 22, color: paidOnchain ? GREEN : MUTED }}>{footerRight}</div>
        </div>
      </div>
    ),
    { ...size },
  );
}

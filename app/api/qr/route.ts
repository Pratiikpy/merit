import { NextResponse } from "next/server";
import QRCode from "qrcode";

export const runtime = "nodejs";

// GET /api/qr?data=<text> — a scannable QR as SVG. Same-origin image (CSP-safe), used by Merit Links so a
// judge can scan on-stage and settle real USDC. Cached hard (a QR for a given string never changes).
export async function GET(req: Request) {
  const data = (new URL(req.url).searchParams.get("data") || "").slice(0, 1200);
  if (!data) return NextResponse.json({ error: "provide ?data=<text>" }, { status: 400 });
  try {
    const svg = await QRCode.toString(data, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0A0A0A", light: "#FFFFFF" },
    });
    return new NextResponse(svg, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
    });
  } catch {
    return NextResponse.json({ error: "could not generate QR" }, { status: 400 });
  }
}

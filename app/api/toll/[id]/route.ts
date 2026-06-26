import { NextResponse } from "next/server";
import { getSource } from "@/lib/registry";
import { decideToll } from "@/lib/toll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/toll/:id — the citation-toll boundary (W3). An AI-agent crawler (by User-Agent) gets HTTP 402
// with the x402 payment requirements to cite this source on Arc; with an X-PAYMENT proof header it receives
// the source content + a citation acknowledgement. MERIT_TOLL_ALL=1 tolls every request (for the demo);
// humans read free otherwise. Speaks the exact x402 rail AWS/Cloudflare/Stripe are standardizing on.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const source = getSource(id);
  if (!source) return NextResponse.json({ error: `no source "${id}"` }, { status: 404 });

  const ua = req.headers.get("user-agent") || "";
  const payment = req.headers.get("x-payment");
  const d = decideToll({ ua, payment, tollAll: process.env.MERIT_TOLL_ALL === "1" }, source);

  if (d.status === 402) {
    return NextResponse.json(d.quote, {
      status: 402,
      headers: { "Accept-Payment": "x402", "X-Payment-Network": "arc-testnet" },
    });
  }

  // Paid (or a human reader): return the cited content. A real settlement verifies the X-PAYMENT proof via
  // the x402 facilitator (lib/seller.ts) before releasing to the author; here the citation is acknowledged.
  return NextResponse.json({
    source: { id: source.id, name: source.name, merit: source.merit },
    content: source.content,
    paid: !!payment,
    receipt: payment
      ? { resource: `merit:citation:${source.id}`, payTo: source.wallet, settled: true, note: "x402 payment acknowledged — verify via the facilitator" }
      : null,
  });
}

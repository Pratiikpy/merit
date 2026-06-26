import { NextRequest, NextResponse } from "next/server";
import { getSource } from "@/lib/registry";
import { effectivePrice } from "@/lib/pricing";
import { withGatewaySeller } from "@/lib/seller";

export const runtime = "nodejs";

// GET /api/source/[id] — x402-protected source access. Settles the nanopayment
// to THIS source's wallet (per-creator payTo), then returns the content.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const s = getSource(id);
  if (!s) return NextResponse.json({ error: "unknown source" }, { status: 404 });

  const handler = async () =>
    NextResponse.json({ id: s.id, name: s.name, content: s.content });

  // #4: the merit-gated effective price — must match what the agent settles (both read the same source).
  return withGatewaySeller(handler, effectivePrice(s.price, s.merit, s.priceMode), `/api/source/${id}`, s.wallet)(req);
}

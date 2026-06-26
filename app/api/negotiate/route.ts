import { NextResponse } from "next/server";
import { negotiate } from "@/lib/negotiate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/negotiate { ask, reservation, sellerMerit, floor?, maxRounds? } → the negotiated price or a
// walk-away. Exposes the agent-to-agent price negotiation (W4) as a callable protocol primitive so any agent
// can bargain a per-citation toll, not just read a posted price.
export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const ask = Number(b?.ask);
  const reservation = Number(b?.reservation);
  const sellerMerit = Number(b?.sellerMerit);
  if (![ask, reservation, sellerMerit].every(Number.isFinite)) {
    return NextResponse.json({ error: "provide numeric { ask, reservation, sellerMerit }" }, { status: 400 });
  }
  return NextResponse.json(
    negotiate({
      ask,
      reservation,
      sellerMerit,
      floor: b?.floor != null ? Number(b.floor) : undefined,
      maxRounds: b?.maxRounds != null ? Number(b.maxRounds) : undefined,
    }),
  );
}

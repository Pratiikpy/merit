import { NextResponse } from "next/server";
import { parseRslLicense, attributionProof } from "@/lib/rsl";
import { getSource } from "@/lib/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/rsl { source, claim, supported, confidence, license? } → the attribution PROOF: a per-citation
// settlement instruction bound to a verdict — the thing RSL/Tollbit admit they cannot produce. Positions
// Merit as the verifiable proof layer ABOVE the per-crawl toll (W4).
export async function POST(req: Request) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const claim = String(b?.claim || "").trim();
  const sourceKey = String(b?.source || "").trim();
  if (!claim || !sourceKey) return NextResponse.json({ error: "provide { source, claim }" }, { status: 400 });
  const license = parseRslLicense(String(b?.license || ""));
  const src = getSource(sourceKey);
  return NextResponse.json(
    attributionProof({
      sourceId: src?.id || sourceKey,
      claim,
      supported: !!b?.supported,
      confidence: Number(b?.confidence) || 0,
      license,
    }),
  );
}

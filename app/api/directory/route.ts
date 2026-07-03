import { NextResponse } from "next/server";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { getSources, refreshRegistryFromMirror } from "@/lib/registry";
import { rankCandidates } from "@/lib/buyer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/directory — the verified-quality service directory. A read-only listing of every buyable source,
// ranked by VERIFIED-QUALITY-PER-DOLLAR: each source's measured citation-faithfulness (lib/learn.reliability,
// the signal a price/latency directory can't produce) blended with its on-chain reputation, over its price. An
// agent browses this to shortlist before it spends; POST /api/buy then buys the best that actually verifies for
// a specific claim. Discovery moves no value, so it needs no key — only a rate limit.
export async function GET(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) return NextResponse.json({ error: "busy — try again in a moment" }, { status: rl.status });

  await refreshRegistryFromMirror().catch(() => {});
  const ranked = rankCandidates(getSources().filter((s) => s.content && s.content.length > 0));

  return NextResponse.json({
    count: ranked.length,
    rankedBy: "verifiedQuality / price (best value first)",
    sources: ranked.map((c, i) => ({
      rank: i + 1,
      id: c.id,
      name: c.name,
      price: c.price, // effective USDC per use
      merit: c.merit, // 0..100 on-chain reputation
      reliability: c.reliability, // 0..1 measured citation-faithfulness
      evidence: c.evidence, // observations behind `reliability`
      verifiedQuality: c.verifiedQuality, // 0..1 blended quality score
      valuePerDollar: c.valuePerDollar, // the rank key
    })),
    buy: {
      endpoint: "/api/buy",
      method: "POST",
      input: { claim: "string", maxTry: "number (optional)" },
      note: "Buys the best-value source that actually VERIFIES the claim; pays nothing for the ones that don't.",
    },
    note: "verifiedQuality is a signal only a verification layer can emit — a source's measured citation-faithfulness, not a self-reported rating. reliability sits near 0.5 until a source has settlement history.",
  });
}

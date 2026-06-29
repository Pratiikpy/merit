import { NextResponse } from "next/server";
import { readBench, benchStats } from "@/lib/bench";
import { goldSummary } from "@/lib/goldset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/benchmark — the proof-of-citation benchmark. `goldSet` is the FIXED, published baseline (scored
// 100% P/R by `npm run judge-eval`); `total` is the SELF-BOOTSTRAPPING set — the boundary-confidence citations
// the live verifier was least sure about, harvested from real runs (it grows from 0 with traffic). Together:
// a reproducible baseline that co-evolves, instead of a static snapshot. Pure data; never gates a payment.
export async function GET() {
  const g = goldSummary();
  return NextResponse.json({
    goldSet: g.goldSet,
    adversarial: g.adversarial,
    precisionRecall: g.precisionRecall,
    ...benchStats(), // total = NEW hard cases harvested from live traffic (distinct from the fixed gold set)
    candidates: readBench().slice(-50).reverse(),
  });
}

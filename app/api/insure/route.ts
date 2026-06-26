import { NextRequest, NextResponse } from "next/server";
import { getSource, getSources } from "@/lib/registry";
import { quotePremium, insuranceEnabled } from "@/lib/insurance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/insure?coverage=&source= — a premium quote to GUARANTEE a job (#17), priced by the source's
// reputation: high-reputation sources are cheap to insure, low-rep ones expensive. The quote is pure (no
// chain); binding a real policy requires the deployed Insurance contract (onchain flag below).
export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams;
  const coverage = Math.max(0, Math.min(100, Number(q.get("coverage")) || 0.05));
  const key = (q.get("source") || "").trim();
  const src = key ? getSource(key) || getSources().find((s) => s.name.toLowerCase() === key.toLowerCase()) : undefined;
  const reputation = src?.merit ?? 50;
  const premium = quotePremium(coverage, reputation);
  return NextResponse.json({
    schema: "merit.insure/v1",
    source: src?.name ?? null,
    reputation,
    coverage,
    premium,
    rate: coverage > 0 ? premium / coverage : 0,
    onchain: insuranceEnabled(),
    note: "Premium = coverage × 5% × risk, where risk falls with reputation. Bind a real policy on the deployed Insurance contract.",
  });
}

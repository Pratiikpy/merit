import { NextResponse } from "next/server";
import { readBench, benchStats } from "@/lib/bench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/benchmark — the self-bootstrapping gold set: the boundary-confidence citations the live verifier was
// least sure about, accumulated from real runs. Unlike a static 100% P/R snapshot, this set grows with traffic —
// the hard cases a meta-adjudicator can promote into the benchmark. Pure data; never gates a payment.
export async function GET() {
  return NextResponse.json({
    ...benchStats(),
    candidates: readBench().slice(-50).reverse(),
  });
}

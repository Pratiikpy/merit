import { NextResponse } from "next/server";
import { ledgerHistory, ledgerTotals } from "@/lib/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/metrics/history[?n=200] — the append-only settlement time-series + the MONOTONIC cumulative
// totals (Bet 3). The cumulative only ever grows and is independent of the capped entries tail, so the
// traction counter never falls on refresh or reset.
export async function GET(req: Request) {
  const n = Math.max(1, Math.min(1000, Number(new URL(req.url).searchParams.get("n")) || 200));
  return NextResponse.json({ cumulative: ledgerTotals(), entries: ledgerHistory(n) });
}

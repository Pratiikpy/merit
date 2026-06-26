import { NextResponse } from "next/server";
import { surprisinglyPopular, btsScores, type BtsReport } from "@/lib/bts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/resolve { reports: [{ answer: 0|1, prediction: 0..1 }] } → the Surprisingly-Popular verdict on a
// contested citation + the per-validator Bayesian-Truth-Serum scores. Peer-prediction resolution with NO
// ground truth and no single trusted Auditor (W4).
export async function POST(req: Request) {
  let b: { reports?: unknown };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const reports: BtsReport[] = Array.isArray(b?.reports)
    ? (b.reports as unknown[])
        .filter((r): r is { answer: 0 | 1; prediction: number } => {
          const o = r as { answer?: unknown; prediction?: unknown };
          return (o?.answer === 0 || o?.answer === 1) && Number.isFinite(Number(o?.prediction));
        })
        .map((r) => ({ answer: r.answer, prediction: Number(r.prediction) }))
    : [];
  if (!reports.length) {
    return NextResponse.json({ error: "provide reports: [{ answer: 0|1, prediction: 0..1 }]" }, { status: 400 });
  }
  return NextResponse.json({ verdict: surprisinglyPopular(reports), scores: btsScores(reports) });
}

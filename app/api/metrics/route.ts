import { NextResponse } from "next/server";
import { snapshotMetrics } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/metrics — the live metrics snapshot (W3): sources, onboarded principals, the self-improving
// Auditor's appeal calibration, total USDC settled, and the per-source earnings leaderboard. Feeds the
// dashboard and the machine-tracked Canteen traction push (scripts/canteen-push.mjs).
export async function GET() {
  return NextResponse.json(snapshotMetrics());
}

import { NextResponse } from "next/server";
import { snapshotMetrics } from "@/lib/metrics";
import { hydrateDoc, ephemeralStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/metrics — the live metrics snapshot (W3): sources, onboarded principals, the self-improving
// Auditor's appeal calibration, total USDC settled, and the per-source earnings leaderboard. Feeds the
// dashboard and the machine-tracked Canteen traction push (scripts/canteen-push.mjs).
export async function GET() {
  // On a cold serverless instance the durable docs may not be hydrated yet (Vercel's boot hook is
  // unreliable), so a first read would return zeros. Pull the metrics-relevant docs from the Supabase mirror
  // FIRST (hydrateDoc is a no-op once the local file exists, so warm instances pay nothing) — then every
  // /api/metrics response carries the real persisted totals, including the agent-labor market.
  if (ephemeralStore()) {
    await Promise.all(["ledger", "history", "registry", "agentlabor"].map((n) => hydrateDoc(n).catch(() => false)));
  }
  return NextResponse.json(snapshotMetrics());
}

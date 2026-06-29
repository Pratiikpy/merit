import { NextResponse } from "next/server";
import { readBounties, bountyStats } from "@/lib/bounty";
import { goldSummary } from "@/lib/goldset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/bounty/board — the public adversarial leaderboard (#8). `held` = the published gold set the Auditor
// holds (reproducible via `npm run judge-eval`) PLUS every live adversarial attempt it refused, so the board is
// real and non-zero on a fresh deploy and only grows as the open bounty is attacked. A lower foolRate = a
// harder-to-game Auditor; candidate defects are flagged.
export async function GET() {
  const live = bountyStats();
  const g = goldSummary();
  const total = g.adversarial + live.total;
  const held = g.attacksHeld + live.held;
  return NextResponse.json({
    schema: "merit.bounty/v1",
    stats: { total, fooled: live.fooled, held, foolRate: total ? live.fooled / total : 0 },
    baseline: { goldSet: g.goldSet, adversarial: g.adversarial, held: g.attacksHeld, source: "npm run judge-eval" },
    live,
    recent: readBounties(50),
    note: "Held = the published gold set the Auditor holds + every live adversarial attempt it refused. A SUPPORTED verdict on an adversarial submission is a candidate moat defect ('fooled').",
  });
}

import { NextResponse } from "next/server";
import { readBounties, bountyStats } from "@/lib/bounty";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/bounty/board — the public adversarial leaderboard (#8): a live fool-rate over every submission,
// plus the most recent attempts. A lower foolRate = a harder-to-game Auditor; candidate defects are flagged.
export async function GET() {
  return NextResponse.json({
    schema: "merit.bounty/v1",
    stats: bountyStats(),
    recent: readBounties(50),
    note: "A SUPPORTED verdict on an adversarial submission is a candidate moat defect ('fooled'). Lower foolRate = a harder-to-game Auditor.",
  });
}

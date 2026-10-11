import { NextResponse } from "next/server";
import { listTicks, autonomousStats, refreshAutonomousFromMirror, runAutonomousTick, AUTONOMOUS_CAPS, AUTONOMOUS_BACKLOG } from "@/lib/autonomous";
import { readTreasuryBalance, treasuryAddress } from "@/lib/treasury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120; // a tick is a full agent run: discovery + hire + verify + settle

// GET /api/autonomous — the public log: Arc's "zero-person company" archetype, running on a schedule
// (app/api/cron/autonomous), not a human clicking a button. Every tick is recorded here, including a
// skip (a safety cap held) or an error — never silently missing.
export async function GET() {
  await refreshAutonomousFromMirror().catch(() => {});
  const balance = await readTreasuryBalance();
  return NextResponse.json({
    treasury: { address: treasuryAddress(), balanceUsdc: balance },
    caps: AUTONOMOUS_CAPS,
    backlogSize: AUTONOMOUS_BACKLOG.length,
    stats: autonomousStats(),
    ticks: listTicks(40),
  });
}

// POST /api/autonomous — admin-only manual trigger, for testing/demo without waiting for the cron
// schedule. Runs the exact same tick the cron runs; real money, real caps, same code path.
export async function POST(req: Request) {
  const admin = req.headers.get("x-admin-token");
  if (!admin || admin !== process.env.MERIT_ADMIN_TOKEN) return NextResponse.json({ error: "admin only" }, { status: 401 });
  const tick = await runAutonomousTick();
  return NextResponse.json({ tick });
}

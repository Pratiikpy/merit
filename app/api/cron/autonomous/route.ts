import { NextResponse } from "next/server";
import { runAutonomousTick } from "@/lib/autonomous";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GET /api/cron/autonomous — invoked on a schedule by Vercel Cron (see vercel.json). Vercel sends
// `Authorization: Bearer ${CRON_SECRET}` automatically when CRON_SECRET is configured on the
// project; anything else is refused, so this can't be triggered (and money can't be spent) by an
// arbitrary request to the URL. Local/manual testing goes through POST /api/autonomous instead,
// which runs the identical tick under MERIT_ADMIN_TOKEN.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured — autonomous cron is disabled" }, { status: 503 });
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tick = await runAutonomousTick();
  return NextResponse.json({ tick });
}

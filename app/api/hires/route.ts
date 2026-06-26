import { NextResponse } from "next/server";
import { externalHires } from "@/lib/hires";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/hires — the append-only log of EXTERNAL agent hires (runs authenticated by a third-party API key,
// not Merit's own anonymous path). The honest, unfakeable traction signal (Bet 2): other agents hiring Merit
// unprompted. count + distinctPrincipals are the numbers that survive a wash-trading judge.
export async function GET() {
  return NextResponse.json(externalHires());
}

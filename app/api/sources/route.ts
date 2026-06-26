import { NextResponse } from "next/server";
import { getSources, publicView } from "@/lib/registry";

export const runtime = "nodejs";

// GET /api/sources — the candidate sources the agent can hire (public view).
export async function GET() {
  return NextResponse.json({ sources: getSources().map(publicView) });
}

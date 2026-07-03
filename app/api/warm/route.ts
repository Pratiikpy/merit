import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/warm — keep-warm ping, invoked by the Vercel cron (vercel.json). Free HF Spaces sleep after ~48h
// idle and a cold NLI Space adds 30-60s to the first verify (it fails safe to the judge, but a warm Space keeps
// the demo snappy). The daily ping resets the idle clock so the Space never reaches the sleep threshold.
export async function GET() {
  const nliUrl = (process.env.MERIT_NLI_URL || "").replace(/\/(score)?\/?$/, "");
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  if (nliUrl) {
    try {
      const r = await fetch(`${nliUrl}/healthz`, { signal: AbortSignal.timeout(55000), cache: "no-store" });
      out.nli = { ok: r.ok, status: r.status };
    } catch (e) {
      out.nli = { ok: false, error: (e as Error).message.slice(0, 80) };
    }
  } else {
    out.nli = { ok: false, error: "MERIT_NLI_URL not configured" };
  }
  return NextResponse.json(out);
}

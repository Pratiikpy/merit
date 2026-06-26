import { NextResponse } from "next/server";
import { globalCalibration, reflection, reliability, confidenceMultiplier } from "@/lib/learn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/learn[?source=<id>] — the self-improving Auditor's learning curve (W1.3). Without a source: the
// global appeal calibration (how many independent re-audits were upheld vs overturned). With ?source=<id>:
// that source's blended reliability, the payout multiplier the learner applies to its supported citations,
// and a Reflexion-style one-line reflection on its track record.
export async function GET(req: Request) {
  const source = new URL(req.url).searchParams.get("source");
  const global = globalCalibration();
  if (source) {
    return NextResponse.json({
      source,
      reliability: reliability(source),
      multiplier: confidenceMultiplier(source),
      reflection: reflection(source),
      global,
    });
  }
  return NextResponse.json({
    global,
    note: "Pass ?source=<id> for a source's learned reliability + the payout multiplier the Auditor applies to it.",
  });
}

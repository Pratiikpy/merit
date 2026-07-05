import { NextResponse } from "next/server";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { evaluate, listEvaluator, evaluatorStats, refreshEvaluatorFromMirror, ESCROW_DEFAULT } from "@/lib/evaluator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45; // the adversarial deliverable-vs-brief grader

// ERC-8183 Evaluator-of-record (the moat move for cat 4) — a neutral, reusable evaluator any external escrow /
// agent-labor market plugs into the ERC-8183 evaluator slot. Merit does not hold the escrow; it returns the
// signed accept/reject verdict the escrow's own hook settles on. A dispute re-runs the same deterministic grade.
//
// POST /api/evaluator { brief, requirements?, deliverable, escrowUsdc?, jobRef? }
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) {
    return NextResponse.json(
      { error: rl.status === 429 ? "rate_limited" : "busy", retryAfterMs: rl.retryMs },
      { status: rl.status, headers: { "Retry-After": String(Math.ceil((rl.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { brief?: string; requirements?: string[]; deliverable?: string; escrowUsdc?: number; jobRef?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  await refreshEvaluatorFromMirror().catch(() => {});
  const res = await evaluate({
    brief: body.brief || "",
    requirements: Array.isArray(body.requirements) ? body.requirements : [],
    deliverable: body.deliverable || "",
    escrowUsdc: body.escrowUsdc,
    jobRef: body.jobRef,
    record: true,
  });
  if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({
    receipt: res.receipt,
    note: "Neutral ERC-8183 evaluator. Merit returns a signed accept/reject certificate + release/refund decision — YOUR escrow's hook settles on it. Same verificationId links it to the on-chain job. Dispute = re-POST the same deliverable for a deterministic re-grade.",
  });
}

// GET /api/evaluator → the evaluator manifest, default escrow, recent verdicts, and the accept/reject split
export async function GET() {
  await refreshEvaluatorFromMirror().catch(() => {});
  return NextResponse.json({
    evaluator: "merit.gig/v1",
    defaultEscrowUsdc: ESCROW_DEFAULT,
    usage: {
      method: "POST",
      body: { brief: "string", requirements: "string[] (optional)", deliverable: "string", escrowUsdc: "number (optional)", jobRef: "string (optional)" },
      returns: { decision: "release | refund", released: "number", accepted: "boolean", score: "0..1", certificate: "signed merit.gig/v1", verificationId: "0x…" },
    },
    recent: listEvaluator(30),
    stats: evaluatorStats(),
  });
}

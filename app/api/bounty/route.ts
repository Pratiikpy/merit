import { NextResponse } from "next/server";
import { getSource, getSources } from "@/lib/registry";
import { judgeCitation, looksLikeInjection } from "@/lib/llm";
import { fabricatedFigures } from "@/lib/numcheck";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { recordBounty } from "@/lib/bounty";
import { recordBenchCandidates } from "@/lib/bench";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/bounty { source, claim } — the adversarial bounty arena (#8). Try to fool the Auditor into
// PAYING a bad citation. Runs the SAME layered Auditor as a real run (deterministic numeric → LLM judge),
// records the outcome, and reports whether you fooled it. The board aggregates a live fool-rate — a
// crowdsourced, never-ending judge-eval. Rate-limited (an LLM-bearing endpoint), same as /api/challenge.
export async function POST(req: Request) {
  const gate = checkChallengeLimit(Date.now());
  if (!gate.allowed) {
    return NextResponse.json(
      { error: gate.status === 429 ? "rate_limited" : "busy", retryAfterMs: gate.retryMs },
      { status: gate.status, headers: { "Retry-After": String(Math.ceil((gate.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { source?: string; claim?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const key = (body.source || "").trim();
  const claim = (body.claim || "").trim();
  if (!key || !claim) return NextResponse.json({ error: "provide { source, claim }" }, { status: 400 });
  if (claim.length > 2000) return NextResponse.json({ error: "claim too long (max 2000 chars)" }, { status: 400 });
  if (looksLikeInjection(claim)) {
    return NextResponse.json({ error: "claim rejected as a likely prompt-injection attempt" }, { status: 400 });
  }
  const src = getSource(key) || getSources().find((s) => s.name.toLowerCase() === key.toLowerCase());
  if (!src) return NextResponse.json({ error: `no source "${key}" in the registry` }, { status: 404 });

  // The layered Auditor: deterministic numeric check first, then the LLM judge — exactly the run path.
  const fab = fabricatedFigures(claim, src.content);
  let verdict: "SUPPORTED" | "REFUSED";
  let by: string;
  if (fab.length > 0) {
    verdict = "REFUSED";
    by = "deterministic numeric check";
  } else {
    const j = await judgeCitation(claim, src.content);
    if (j === null) {
      return NextResponse.json({ error: "the Auditor's LLM judge is unavailable — retry when the key resets" }, { status: 503 });
    }
    verdict = j === "unclear" || j.refuted ? "REFUSED" : "SUPPORTED";
    by = "LLM judge";
  }
  const fooled = verdict === "SUPPORTED";
  recordBounty({ source: src.name, claim, verdict, fooled, by, at: Date.now() });
  // Antifragile: every adversarial attempt is harvested into the gold set — the verifier gets HARDER to fool
  // as people attack it. (Break-the-Verifier console.) Deduped by source+claim in the bench store.
  recordBenchCandidates([{ source: src.name, claim, verdict: fooled ? "released" : "refused", confidence: 0.5, runId: "attack", at: Date.now() }]);

  return NextResponse.json({
    source: src.name,
    claim,
    verdict,
    fooled,
    by,
    result: fooled
      ? "FOOLED — the Auditor PAID this citation. Logged as a candidate moat defect. You win if it's genuinely unsupported."
      : "HELD — the Auditor refused. The moat stood; try a subtler mis-citation.",
    board: "/api/bounty/board",
  });
}

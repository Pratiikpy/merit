import { NextResponse } from "next/server";
import { verifyCitation, isVerifyError } from "@/lib/verify/engine";
import { checkChallengeLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/verify — the Citation Verification Oracle (CVO). Given a raw (claim, source) pair from ANY agent
// (not just Merit's own runs), run Merit's verification engine — deterministic numeric verifier → pluggable
// NLI/factual-consistency (HHEM/MiniCheck-style) → adversarial LLM judge — and return a SIGNED, tamper-evident
// verdict an ERC-8183 settlement hook (or any payment) can consume BEFORE paying a citation. The engine
// (lib/verify/engine.ts) is the single source of truth, so this HTTP endpoint, the run path, and the
// `verify_citation` MCP tool all decide identically. Verification as a standalone product: the truth-check every
// reading agent needs underneath — including the self-report agents whose "citation" is one LLM grading its own homework.
export async function POST(req: Request) {
  const gate = checkChallengeLimit(Date.now());
  if (!gate.allowed) {
    return NextResponse.json(
      { error: gate.status === 429 ? "rate_limited" : "busy", retryAfterMs: gate.retryMs },
      { status: gate.status, headers: { "Retry-After": String(Math.ceil((gate.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { claim?: string; source?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Layered verifier lives in the engine: numeric check needs no LLM, so a fabricated FIGURE is caught even in a
  // keyless deployment; NLI + LLM judge add coverage when configured (see HUMAN.md). Verdicts are signed so a
  // third party (or a settlement hook) can recover the signer offline without trusting Merit's server.
  const out = await verifyCitation(body.claim ?? "", body.source ?? "");
  if (isVerifyError(out)) {
    return NextResponse.json(
      { error: out.error, ...(out.numericOnly ? { numericOnly: true } : {}) },
      { status: out.status },
    );
  }

  const v = out.verdict;
  return NextResponse.json({
    ...v,
    by: v.methods.join(" + "), // back-compat alias for the layer(s) that decided
    reasoning: v.reason, // back-compat alias
    settlement: v.grounded
      ? "GROUNDED — a verification-gated payment MAY settle this citation."
      : "NOT GROUNDED — a verification-gated payment MUST REFUSE this citation. (A self-report system would pay it.)",
  });
}

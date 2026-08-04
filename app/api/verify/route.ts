import { NextResponse } from "next/server";
import { verifyCitation, isVerifyError } from "@/lib/verify/engine";
import { verifyWithCache, refreshVcacheFromMirror } from "@/lib/vcache";
import { asDepth, depthLayers } from "@/lib/pricing";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { recordAuditVerdict, refreshAuditFromMirror } from "@/lib/audit";
import { extractSourceFromUrl } from "@/lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // the adversarial judge call can take several seconds; don't let the default cut it off

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
  let body: { claim?: string; source?: string; sourceURL?: string; depth?: string; amount?: number; payee?: string; nonce?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Zero-friction path: accept a URL as the source. The page is fetched SSRF-guarded (extractSourceFromUrl
  // resolves+validates the host and pins the connection), extracted to text, and verified like any pasted
  // source. An explicit pasted `source` always wins; the URL leg only runs when no source text was given.
  let source = body.source ?? "";
  let fetchedFrom: string | undefined;
  if (!source.trim() && typeof body.sourceURL === "string" && body.sourceURL.trim()) {
    const ex = await extractSourceFromUrl(body.sourceURL.trim());
    if (!ex.ok) return NextResponse.json({ error: `could not read the source URL: ${ex.error}` }, { status: 400 });
    source = ex.text;
    fetchedFrom = body.sourceURL.trim();
  }

  // Layered verifier lives in the engine: numeric check needs no LLM, so a fabricated FIGURE is caught even in a
  // keyless deployment; NLI + LLM judge add coverage when configured (see HUMAN.md). Verdicts are signed so a
  // third party (or a settlement hook) can recover the signer offline without trusting Merit's server. The
  // verified-citation cache serves an identical (claim, source) from its already-signed verdict, skipping the
  // recompute (a changed source hashes differently → re-verifies). The `depth` tier (B6) picks which layers run;
  // the cache key is depth-scoped so a shallow (numeric/NLI-only) verdict is never served for a full request.
  const depth = asDepth(body.depth);
  const { useNLI, useJudge } = depthLayers(depth);
  // Payment binding (anti confused-deputy): when amount+payee are given, the signed verdict authorizes exactly
  // that payment. Bound requests BYPASS the verified-citation cache — an unbound cached verdict must never be
  // served where a binding was requested, and per-payment verdicts shouldn't pollute the (claim, source) cache.
  const binding =
    typeof body.amount === "number" && Number.isFinite(body.amount) && body.amount > 0 && typeof body.payee === "string" && body.payee.trim()
      ? { amount: body.amount, payee: body.payee.trim(), ...(typeof body.nonce === "string" && body.nonce.trim() ? { nonce: body.nonce.trim() } : {}) }
      : undefined;

  const cacheClaim = depth === "full" ? (body.claim ?? "") : `${body.claim ?? ""} [depth:${depth}]`;
  await refreshVcacheFromMirror().catch(() => {});
  const { outcome: out, cached } = binding
    ? { outcome: await verifyCitation(body.claim ?? "", source, { useNLI, useJudge, binding }), cached: false }
    : await verifyWithCache(cacheClaim, source, () => verifyCitation(body.claim ?? "", source, { useNLI, useJudge }));
  if (isVerifyError(out)) {
    return NextResponse.json(
      { error: out.error, ...(out.numericOnly ? { numericOnly: true } : {}) },
      { status: out.status },
    );
  }

  const v = out.verdict;
  if (!cached) {
    try {
      await refreshAuditFromMirror(); // read-your-writes: append onto the authoritative log, not a stale cache
      recordAuditVerdict(v, body.claim ?? ""); // EU AI Act Art.12 traceability — tamper-evident, best-effort
    } catch {
      /* the audit log never fails a verdict */
    }
  }
  return NextResponse.json({
    ...v,
    ...(fetchedFrom ? { sourceURL: fetchedFrom } : {}), // the URL the source text was extracted from (SSRF-guarded)
    cached, // true when served from the verified-citation cache (recompute skipped; same signed verdict)
    depth, // the verification depth tier that ran (numeric | nli | full)
    by: v.methods.join(" + "), // back-compat alias for the layer(s) that decided
    reasoning: v.reason, // back-compat alias
    settlement: v.grounded
      ? "GROUNDED — a verification-gated payment MAY settle this citation."
      : "NOT GROUNDED — a verification-gated payment MUST REFUSE this citation. (A self-report system would pay it.)",
    // The self-contained signed receipt: the top level mixes the signed verdict with unsigned presentation
    // fields (cached/depth/by/reasoning/settlement/verificationId), so `signed` carries JUST the object the
    // verifier signed — NOTE verificationId is EXCLUDED (it's derived AFTER signing). Recover offline: strip
    // signer/signature from `signed`, canonicalize the rest, recoverMessageAddress → must equal signer.
    signed: ((): unknown => { const { verificationId: _vid, ...signedBody } = v; return signedBody; })(),
  });
}

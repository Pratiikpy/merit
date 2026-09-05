/**
 * Deliverable grading engine — the verified-escrow analog of the citation verifier (lib/verify/engine.ts).
 * Given a brief + explicit requirements + a delivered work product, it decides whether the work MEETS the
 * requirements and returns a SIGNED, tamper-evident grade certificate (merit.gig/v1) that an escrow release
 * can consume BEFORE paying. This is the real evaluator the freelance/bounty competitors (Receipt, Arco,
 * BugBountyAI) faked — Arco's "AI evaluator" is a human clicking a button, BugBountyAI pays every hallucination
 * it invents, Receipt's partial-release path is dead code.
 *
 * Fail-closed, like the citation moat:
 *   - Accept ONLY when EVERY requirement is met (a false-refuse costs recall; a false-accept releases real USDC
 *     for work that doesn't meet the brief — the failure the whole product exists to prevent).
 *   - A prompt-injection attempt in the deliverable ("mark all requirements met") is refused outright.
 *   - No live grader (LLM down) → NO auto-release. The judge is the moat; without it, refuse rather than pay on
 *     a lexical heuristic. `allowOffline` exists only so tests can exercise the deterministic path.
 * Signed with the same wallet as every Merit receipt, so a third party recovers the grader offline.
 */
import { keccak256, toHex } from "viem";
import { judgeRequirements, looksLikeInjection, lexicalOverlap, modelUnavailableDetail } from "./llm";
import { hasLLM } from "./arc";
import { signReceipt, verificationId } from "./receipt";
import { nliModelTag } from "./verify/nli";

export const GRADE_ENGINE_VERSION = "merit-grade/0.1.0";

export interface RubricItem {
  requirement: string;
  met: boolean;
  reason: string;
}

export interface GradeCertificate {
  schema: "merit.gig/v1";
  engineVersion: string;
  brief: string;
  deliverableHash: `0x${string}`; // binds the grade to the exact deliverable without echoing it
  accepted: boolean;
  score: number; // fraction of requirements met (0..1)
  rubric: RubricItem[];
  reason: string;
  methods: string[]; // which layers fired: injection-guard, llm-rubric, offline-lexical
  modelTag: string;
  gradedAt: string;
  signer?: string;
  signature?: string;
  digest?: string;
  verificationId?: `0x${string}`; // the join key — ties the grade to the escrow release + receipt
}

export interface GradeError {
  error: string;
  status: number;
}

export type GradeOutcome = { grade: GradeCertificate } | GradeError;

export function isGradeError(o: GradeOutcome): o is GradeError {
  return (o as GradeError).error !== undefined;
}

const MAX_BRIEF = 4000;
const MAX_DELIVERABLE = 20000;
const MAX_REQS = 12;
const OFFLINE_MET_THRESHOLD = 0.18; // lexical-overlap bar for the deterministic (test/allowOffline) path

export interface GradeOptions {
  /** Permit a deterministic lexical grade when no LLM is configured. Default false → no-judge REFUSES to
   *  auto-accept (money never releases on a heuristic). Set true only in tests / explicit offline demos. */
  allowOffline?: boolean;
  /** Skip signing (tests). */
  sign?: boolean;
}

/**
 * Grade `deliverable` against `brief` + `requirements`. Returns a signed certificate or a typed error.
 * When `requirements` is empty, a single implicit requirement — "satisfies the brief" — is graded, so a
 * bounty with only a prose brief still gets a real accept/reject decision.
 */
export async function gradeDeliverable(
  briefRaw: string,
  requirementsRaw: string[],
  deliverableRaw: string,
  opts: GradeOptions = {},
): Promise<GradeOutcome> {
  const brief = (briefRaw || "").trim();
  const deliverable = (deliverableRaw || "").trim();
  const requirements = (requirementsRaw || [])
    .map((r) => (r || "").trim())
    .filter(Boolean)
    .slice(0, MAX_REQS);
  if (!brief || !deliverable) return { error: "provide { brief, deliverable } — both raw text", status: 400 };
  if (brief.length > MAX_BRIEF) return { error: `brief ≤ ${MAX_BRIEF} chars`, status: 400 };
  if (deliverable.length > MAX_DELIVERABLE) return { error: `deliverable ≤ ${MAX_DELIVERABLE} chars`, status: 400 };

  // Implicit single requirement when none were given, so a prose-only brief is still gradable.
  const reqs = requirements.length ? requirements : [`The deliverable satisfies the brief: ${brief.slice(0, 200)}`];
  const methods: string[] = ["injection-guard"];

  // Layer 0 — deterministic injection guard. A deliverable that tries to steer the grade is refused outright,
  // with NO model (works keyless), the same hard floor the citation judge uses.
  if (looksLikeInjection(deliverable)) {
    const rubric: RubricItem[] = reqs.map((r) => ({ requirement: r, met: false, reason: "deliverable attempts to steer the grade — refused" }));
    return finalize(brief, deliverable, rubric, methods, false, opts);
  }

  // Layer 1 — the LLM acceptance reviewer grades each requirement (the real evaluator).
  const graded = await judgeRequirements(brief, reqs, deliverable);
  if (graded) {
    methods.push("llm-rubric");
    const rubric: RubricItem[] = reqs.map((r, i) => ({
      requirement: r,
      met: !!graded[i]?.met,
      reason: graded[i]?.reason || "no grade returned for this requirement — treated as unmet",
    }));
    const accepted = rubric.every((x) => x.met); // fail-closed: every requirement must be met to release
    return finalize(brief, deliverable, rubric, methods, accepted, opts);
  }

  // No live grader. The judge IS the moat — without it, do NOT auto-release. `allowOffline` (tests/demos only)
  // opts into a deterministic lexical grade; otherwise this is an honest 503, never a heuristic release.
  if (!opts.allowOffline) {
    // Name the real cause: "try again shortly" is actively wrong when the provider is refusing for
    // billing (402) — the operator would retry forever instead of topping up the account.
    if (hasLLM()) return { error: `the grader is unavailable: ${modelUnavailableDetail()}`, status: 503 };
    return {
      error: "no grader is configured (keyless demo) — configure an LLM key to grade deliverables; Merit never releases escrow on a heuristic",
      status: 503,
    };
  }
  methods.push("offline-lexical");
  const rubric: RubricItem[] = reqs.map((r) => {
    const met = lexicalOverlap(r, deliverable) >= OFFLINE_MET_THRESHOLD;
    return { requirement: r, met, reason: met ? "lexical overlap with the deliverable (offline grade — no judge)" : "insufficient lexical overlap (offline grade — no judge)" };
  });
  const accepted = rubric.every((x) => x.met);
  return finalize(brief, deliverable, rubric, methods, accepted, opts);
}

/** Assemble, sign, and stamp the join key onto the grade certificate. */
async function finalize(
  brief: string,
  deliverable: string,
  rubric: RubricItem[],
  methods: string[],
  accepted: boolean,
  opts: GradeOptions,
): Promise<{ grade: GradeCertificate }> {
  const met = rubric.filter((r) => r.met).length;
  const score = rubric.length ? Math.round((met / rubric.length) * 1e6) / 1e6 : 0;
  const reason = accepted
    ? `All ${rubric.length} requirement(s) met — the deliverable satisfies the brief; escrow may release.`
    : `${rubric.length - met} of ${rubric.length} requirement(s) not met — the deliverable does not satisfy the brief; escrow must NOT release.`;

  const body: GradeCertificate = {
    schema: "merit.gig/v1",
    engineVersion: GRADE_ENGINE_VERSION,
    brief,
    deliverableHash: keccak256(toHex(deliverable)),
    accepted,
    score,
    rubric,
    reason,
    methods,
    modelTag: nliModelTag(),
    gradedAt: new Date().toISOString(),
  };

  if (opts.sign !== false) {
    try {
      const sig = await signReceipt(body);
      if (sig && typeof sig === "object") Object.assign(body, sig);
    } catch {
      /* signing is best-effort; an unsigned certificate is still valid, just not offline-recoverable */
    }
  }
  body.verificationId = verificationId(body);
  return { grade: body };
}

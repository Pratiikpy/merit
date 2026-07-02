/**
 * Merit Verification Engine (M1) — the single, standalone citation-faithfulness verifier that powers every
 * surface (CVO API, creator badge, agent-labor market, benchmark). Composes three layers, cheapest-and-hardest
 * first, so a decision is reached with the least cost and the strongest guarantee available:
 *
 *   1. Deterministic numeric verifier (`fabricatedFigures`) — a $/%/figure the source contradicts is REFUSED
 *      with NO model. Fast, unfoolable, works with zero keys. This is Merit's hard differentiator.
 *   2. NLI / factual-consistency scorer (HHEM/MiniCheck-style, pluggable, offline-safe) — a 0..1 support score.
 *      High → SUPPORTED, low → REFUSED, borderline → escalate to the LLM judge. Only runs if configured.
 *   3. Adversarial LLM judge (`judgeCitation`) — injection/trap-resistant, used for borderline or when no NLI.
 *
 * Output is a signed, versioned `Verdict` (schema merit.cvo/v2) any settlement hook or payment can consume
 * BEFORE paying. Correctness-vs-faithfulness note: this verifies whether the SOURCE SUPPORTS THE CLAIM (citation
 * correctness/support) — the settleable, benchmarkable property — not the model's internal reliance.
 *
 * Behavior is a strict superset of the previous /api/verify route: with NLI unconfigured it reduces to
 * "numeric → LLM judge" exactly as before, so nothing regresses; NLI + thresholds are additive.
 */
import { keccak256, toHex } from "viem";
import { judgeCitation, looksLikeInjection } from "../llm";
import { fabricatedFigures } from "../numcheck";
import { signReceipt } from "../receipt";
import { scoreNLI, nliAvailable, nliModelTag } from "./nli";

export const ENGINE_VERSION = "merit-verify/0.1.0";

export type VerifyMethod = "injection-guard" | "numeric" | "nli" | "llm-judge";

export interface Verdict {
  schema: "merit.cvo/v2";
  engineVersion: string;
  claim: string;
  sourceHash: `0x${string}`; // binds the verdict to the exact source without echoing it
  verdict: "SUPPORTED" | "REFUSED";
  grounded: boolean;
  score: number | null; // NLI support probability (0..1) when available, else null
  methods: VerifyMethod[]; // which layers actually fired, in order
  reason: string;
  modelTag: string;
  verifiedAt: string;
  // signature fields (best-effort; present only if a signer wallet is configured)
  signer?: string;
  signature?: string;
  digest?: string;
}

export interface VerifyError {
  error: string;
  status: number;
  numericOnly?: boolean;
}

export type VerifyOutcome = { verdict: Verdict } | VerifyError;

export function isVerifyError(o: VerifyOutcome): o is VerifyError {
  return (o as VerifyError).error !== undefined;
}

export interface VerifyOptions {
  /** Force-enable/disable the NLI layer; defaults to nliAvailable() (i.e. configured via env). */
  useNLI?: boolean;
  /** SUPPORTED threshold for the NLI score (default 0.75). */
  high?: number;
  /** REFUSED threshold for the NLI score (default 0.25); between low..high escalates to the LLM judge. */
  low?: number;
  /** STRICT dual-gate: SUPPORTED only if EVERY available model leg (NLI + judge) confirms support; any that
   *  doesn't → REFUSED. Higher precision at a measured over-refusal cost. Defaults to env MERIT_STRICT_GATE=1. */
  strict?: boolean;
  /** Skip signing (e.g. in tests). */
  sign?: boolean;
}

const MAX_CLAIM = 4000;
const MAX_SOURCE = 20000;

/**
 * Verify that `source` supports `claim`. Returns a signed Verdict or a typed error (with HTTP status).
 * Pure enough to unit-test: the numeric + validation layers need no keys; NLI and the LLM judge are optional.
 */
export async function verifyCitation(
  claimRaw: string,
  sourceRaw: string,
  opts: VerifyOptions = {},
): Promise<VerifyOutcome> {
  const claim = (claimRaw || "").trim();
  const source = (sourceRaw || "").trim();
  if (!claim || !source) return { error: "provide { claim, source } — both raw text", status: 400 };
  if (claim.length > MAX_CLAIM || source.length > MAX_SOURCE)
    return { error: `claim ≤ ${MAX_CLAIM}, source ≤ ${MAX_SOURCE} chars`, status: 400 };
  if (looksLikeInjection(claim))
    return { error: "claim rejected as a likely prompt-injection attempt", status: 400 };

  const methods: VerifyMethod[] = ["injection-guard"];
  const high = opts.high ?? 0.75;
  const low = opts.low ?? 0.25;

  let verdict: "SUPPORTED" | "REFUSED" | null = null;
  let score: number | null = null;
  let reason = "";

  // Layer 1 — deterministic numeric verifier (no model).
  const fab = fabricatedFigures(claim, source);
  methods.push("numeric");
  if (fab.length > 0) {
    verdict = "REFUSED";
    score = 0;
    reason = `The claim asserts ${fab.map((f) => f.raw).join(", ")}, which the source contradicts (deterministic numeric check).`;
  }

  // Layers 2+3 — STRICT DUAL-GATE. Every AVAILABLE model leg (encoder-NLI + adversarial judge) must
  // independently CONFIRM support (numeric already passed); if any leg fails to confirm, REFUSE. This is the
  // "both gates must agree" mode that makes the verdict a high-precision, harder-to-game signal — at a
  // measured over-refusal cost (see bench-judge). Opt-in via MERIT_STRICT_GATE=1 or opts.strict; when off, the
  // cheaper cascade below runs unchanged. The two legs are independent evidence, so agreement is meaningful.
  const strict = opts.strict ?? process.env.MERIT_STRICT_GATE === "1";
  if (verdict === null && strict) {
    const legs: Array<"support" | "fail"> = [];
    if (opts.useNLI ?? nliAvailable()) {
      const s = await scoreNLI(claim, source);
      if (s !== null) {
        score = s;
        methods.push("nli");
        legs.push(s >= high ? "support" : "fail"); // strict: only a high-confidence NLI score counts as support
      }
    }
    const j = await judgeCitation(claim, source);
    if (j !== null) {
      methods.push("llm-judge");
      const refuted = j === "unclear" || (typeof j === "object" && (j as { refuted?: boolean }).refuted);
      legs.push(refuted ? "fail" : "support");
    }
    if (legs.length === 0) {
      // No model leg available (keyless + no NLI): a non-numeric claim is genuinely undecidable — honest 503.
      return {
        error:
          "the adversarial LLM judge is unavailable (keyless demo) — a claim with a verifiable number is still checked deterministically; configure MERIT_NLI_URL or an LLM key for full verification",
        status: 503,
        numericOnly: true,
      };
    }
    const allConfirm = legs.every((l) => l === "support");
    verdict = allConfirm ? "SUPPORTED" : "REFUSED";
    reason = allConfirm
      ? `Strict dual-gate: all ${legs.length} verifier leg(s) independently confirm the source supports the claim.`
      : `Strict dual-gate refused — not every verifier leg confirmed support (strict mode requires unanimous confirmation).`;
  }

  // Layer 2 — NLI / factual-consistency (pluggable, additive). [cascade mode — skipped when strict already decided]
  if (verdict === null && (opts.useNLI ?? nliAvailable())) {
    score = await scoreNLI(claim, source);
    if (score !== null) {
      methods.push("nli");
      if (score >= high) {
        verdict = "SUPPORTED";
        reason = `Source supports the claim (factual-consistency score ${score.toFixed(3)} ≥ ${high}).`;
      } else if (score <= low) {
        verdict = "REFUSED";
        reason = `Source does not support the claim (factual-consistency score ${score.toFixed(3)} ≤ ${low}).`;
      }
      // else borderline → fall through to the LLM judge
    }
  }

  // Layer 3 — adversarial LLM judge (borderline, or when no numeric/NLI decision).
  if (verdict === null) {
    const j = await judgeCitation(claim, source);
    if (j === null) {
      // No judge available (keyless demo). If NLI gave a (borderline) score, decide by the midpoint so we still
      // return a verdict; otherwise this is genuinely undecidable without a model — surface it honestly.
      if (score !== null) {
        verdict = score >= (high + low) / 2 ? "SUPPORTED" : "REFUSED";
        reason = `LLM judge unavailable; decided by factual-consistency score ${score.toFixed(3)}.`;
      } else {
        return {
          error:
            "the adversarial LLM judge is unavailable (keyless demo) — a claim with a verifiable number is still checked deterministically; configure MERIT_NLI_URL or an LLM key for full verification",
          status: 503,
          numericOnly: true,
        };
      }
    } else {
      methods.push("llm-judge");
      const refuted = j === "unclear" || (typeof j === "object" && (j as { refuted?: boolean }).refuted);
      verdict = refuted ? "REFUSED" : "SUPPORTED";
      reason =
        (typeof j === "object" && (j as { reason?: string }).reason) ||
        (j === "unclear" ? "the source does not clearly support the claim" : "the source supports the claim");
    }
  }

  const grounded = verdict === "SUPPORTED";
  const body: Verdict = {
    schema: "merit.cvo/v2",
    engineVersion: ENGINE_VERSION,
    claim,
    sourceHash: keccak256(toHex(source)),
    verdict,
    grounded,
    score,
    methods,
    reason,
    modelTag: nliModelTag(),
    verifiedAt: new Date().toISOString(),
  };

  if (opts.sign !== false) {
    try {
      const sig = await signReceipt(body);
      if (sig && typeof sig === "object") Object.assign(body, sig);
    } catch {
      /* signing is best-effort; an unsigned verdict is still valid, just not offline-recoverable */
    }
  }

  return { verdict: body };
}

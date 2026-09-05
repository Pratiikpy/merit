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
import { judgeCitation, looksLikeInjection, judgeUnavailableReason, modelUnavailableDetail } from "../llm";
import { fabricatedFigures } from "../numcheck";
import { canonicalize, signReceipt, verificationId } from "../receipt";
import { scoreNLI, nliAvailable, nliModelTag } from "./nli";

export const ENGINE_VERSION = "merit-verify/0.1.0";

export type VerifyMethod = "injection-guard" | "numeric" | "nli" | "llm-judge";

/** Per-gate breakdown — what each of the three verifiers found. Surfaced so a receipt/tool can SHOW the moat
 *  (numeric + NLI + adversarial judge), not just a final verdict. `ran:false` = that gate didn't fire this run. */
export interface GateBreakdown {
  numeric: { ran: boolean; pass: boolean; detail: string };
  nli: { ran: boolean; score: number | null; pass: boolean | null; detail: string };
  judge: { ran: boolean; verdict: "support" | "refute" | null; reason: string };
}

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
  gates?: GateBreakdown; // what each of the three verifiers found (for a shareable, moat-visible receipt)
  // Payment binding (anti confused-deputy): when the caller names the payment this verdict will authorize, the
  // binding is folded INSIDE the signed body — so a verdict for "$5 to payee A" can never be replayed to wave
  // through "$50 to payee B". bindingHash = keccak256(canonical {amount, payee, claim, sourceHash}); any
  // consumer (SDK, hook, rail) recomputes it locally and refuses on mismatch. Absent when no binding was given.
  binding?: { amount: number; payee: string; nonce?: string; bindingHash: `0x${string}` };
  // signature fields (best-effort; present only if a signer wallet is configured)
  signer?: string;
  signature?: string;
  digest?: string;
  // The join key: keccak256 of the canonical signed verdict (see lib/receipt.verificationId). The SAME id
  // appears in the x402 challenge, the receipt, the /proof ledger, reputation, and the on-chain hook proofHash.
  verificationId?: `0x${string}`;
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
  /** Run the adversarial LLM judge (default true). Set false for a shallower, cheaper depth tier: with NLI it
   *  decides by the factual-consistency score alone; without NLI it reduces to the deterministic numeric screen
   *  (a non-numeric claim then returns the honest "needs a model" 503). Reuses the judge-unavailable fallback. */
  useJudge?: boolean;
  /** Skip signing (e.g. in tests). */
  sign?: boolean;
  /** Bind the verdict to one specific payment (amount in USDC + payee, and optionally a caller nonce). The
   *  binding is signed with the verdict, so the receipt cannot authorize a DIFFERENT payment (substitution).
   *  Without a nonce, an identical (amount, payee, claim, source) payment could reuse the receipt — callers
   *  who need one-receipt-one-payment MUST pass a unique `nonce`, which is folded into the signed hash. */
  binding?: { amount: number; payee: string; nonce?: string };
}

/** The versioned binding-hash spec (v1): keccak256(utf8(canonicalJson)) over
 *  { amount, payee, claim, sourceHash } — plus `nonce` when given — with keys sorted lexicographically and
 *  `amount` encoded exactly as ECMAScript JSON.stringify renders the number (shortest round-trip decimal).
 *  Cross-language consumers must reproduce that number encoding byte-for-byte or fail closed. */
export function bindingHash(amount: number, payee: string, claim: string, sourceHash: `0x${string}`, nonce?: string): `0x${string}` {
  return keccak256(toHex(canonicalize(nonce ? { amount, payee, claim, sourceHash, nonce } : { amount, payee, claim, sourceHash })));
}

const MAX_CLAIM = 4000;
const MAX_SOURCE = 20000;

/**
 * The honest 503 message for "no model leg could decide this claim".
 *
 * This used to be a single hardcoded string telling the operator to "configure an LLM key" — which
 * was wrong and expensive whenever a key WAS configured and the provider was refusing the call. An
 * upstream 402 (out of credit), a 401 (bad key), a 429 (rate limited) and a genuinely keyless demo
 * are four different problems for four different people; say which one it is.
 */
export function judgeUnavailableMessage(): string {
  const tail =
    " A claim containing a checkable number is still verified deterministically, so numeric fabrications are still refused.";
  const reason = judgeUnavailableReason();
  switch (reason.kind) {
    case "no-key":
      return (
        "no verification model is configured (keyless demo) — set MERIT_NLI_URL or an LLM key to enable full verification." +
        tail
      );
    case "providers-cooling-down":
      return (
        "the verification models are temporarily unavailable after repeated upstream failures — this is on our side, please retry shortly." +
        tail
      );
    case "upstream-error":
      return `the adversarial LLM judge is unavailable: ${modelUnavailableDetail()}. This is not a missing configuration — a key is configured.${tail}`;
  }
}

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
  const useJudge = opts.useJudge ?? true; // depth tier: false → shallower/cheaper (NLI-only or numeric-only)

  let verdict: "SUPPORTED" | "REFUSED" | null = null;
  let score: number | null = null;
  let reason = "";
  const gates: GateBreakdown = {
    numeric: { ran: false, pass: false, detail: "" },
    nli: { ran: false, score: null, pass: null, detail: "" },
    judge: { ran: false, verdict: null, reason: "" },
  };

  // Layer 1 — deterministic numeric verifier (no model).
  const fab = fabricatedFigures(claim, source);
  methods.push("numeric");
  gates.numeric = {
    ran: true,
    pass: fab.length === 0,
    detail: fab.length ? `the claim asserts ${fab.map((f) => f.raw).join(", ")}, which the source contradicts` : "no fabricated figures — every number in the claim checks out against the source",
  };
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
        const pass = s >= high; // strict: only a high-confidence NLI score counts as support
        gates.nli = { ran: true, score: s, pass, detail: `factual-consistency score ${s.toFixed(3)} ${pass ? "≥" : "<"} ${high} support bar` };
        legs.push(pass ? "support" : "fail");
      }
    }
    const j = useJudge ? await judgeCitation(claim, source) : null;
    if (j !== null) {
      methods.push("llm-judge");
      const refuted = j === "unclear" || (typeof j === "object" && (j as { refuted?: boolean }).refuted);
      gates.judge = {
        ran: true,
        verdict: refuted ? "refute" : "support",
        reason: (typeof j === "object" && (j as { reason?: string }).reason) || (refuted ? "the source does not clearly support the claim" : "the source supports the claim"),
      };
      legs.push(refuted ? "fail" : "support");
    }
    if (legs.length === 0) {
      // No model leg available (keyless + no NLI): a non-numeric claim is genuinely undecidable — honest 503.
      return {
        error: judgeUnavailableMessage(),
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
      const nliPass = score >= high ? true : score <= low ? false : null; // null = borderline → judge decides
      gates.nli = { ran: true, score, pass: nliPass, detail: `factual-consistency score ${score.toFixed(3)} (support ≥ ${high}, refuse ≤ ${low})` };
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
    const j = useJudge ? await judgeCitation(claim, source) : null;
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
      gates.judge = { ran: true, verdict: refuted ? "refute" : "support", reason };
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
    gates,
  };

  // Fold the payment binding into the body BEFORE signing, so the signature covers exactly which payment this
  // verdict authorizes — the anti-confused-deputy guarantee is server-signed fact, not client-side convention.
  // The payee is validated, never silently truncated: a sliced payee would bind a DIFFERENT identity.
  if (opts.binding && Number.isFinite(opts.binding.amount) && opts.binding.payee) {
    const amount = opts.binding.amount;
    const payee = String(opts.binding.payee);
    if (payee.length > 120) return { error: "binding payee too long (max 120 chars) — refusing to truncate a payment identity", status: 400 };
    const nonce = opts.binding.nonce ? String(opts.binding.nonce).slice(0, 80) : undefined;
    body.binding = { amount, payee, ...(nonce ? { nonce } : {}), bindingHash: bindingHash(amount, payee, claim, body.sourceHash, nonce) };
  }

  if (opts.sign !== false) {
    try {
      const sig = await signReceipt(body);
      if (sig && typeof sig === "object") Object.assign(body, sig);
    } catch {
      /* signing is best-effort; an unsigned verdict is still valid, just not offline-recoverable */
    }
  }

  // The join key — computed over the (now signed) verdict, so it commits to the exact bytes. Every downstream
  // surface (402 challenge, receipt, /proof ledger, reputation, on-chain hook proofHash) references THIS id.
  body.verificationId = verificationId(body);

  return { verdict: body };
}

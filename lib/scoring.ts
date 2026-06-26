/**
 * The agent's settlement rules, as pure functions — the "agency" core, so they
 * can be unit-tested in isolation and there's a single source of truth for how a
 * source is judged, how merit moves, and what on-chain reputation score is written.
 */
import { round6 } from "./arc";

export type ReasonKind = "uncited" | "identity" | "unsupported";

/** Whether a hired specialist's work produced verified value worth paying for — the
 *  agent-to-agent "pay only for verified work" rule. A specialist that didn't deliver
 *  (the lead fell back to inline work) never earns; otherwise each role has its own bar:
 *  search found a usable pool, the writer grounded ≥1 paid citation, the verifier checked
 *  every source. */
export function gradeSpecialist(
  role: "search" | "write" | "verify",
  delivered: boolean,
  ctx: { poolSize: number; releaseCount: number; allSourcesChecked: boolean },
): boolean {
  if (!delivered) return false;
  if (role === "search") return ctx.poolSize >= 2;
  if (role === "write") return ctx.releaseCount >= 1;
  return ctx.poolSize > 0 && ctx.allSourcesChecked; // verify
}

/** Labor + this hire must stay within the whole-run budget (creators are paid from the
 *  same budget). A budget hold is NOT a quality failure — callers must not dock merit for it. */
export function withinBudget(laborSoFar: number, price: number, budget: number): boolean {
  return round6(laborSoFar + price) <= budget + 1e-9;
}

/** Reputation a hired specialist earns for good work. **Quality-weighted for the writer** —
 *  the more of its citations cleared verification to be releasable (`releaseCount`, the
 *  pre-settlement verdict count), the more verified value it produced, so a thorough writer
 *  (Scribe) earns reputation faster than a terser one (Quill). Flat for search/verify, whose
 *  delivery is binary (found a pool / checked every source). Reputation is quality-EARNED, not seeded. */
export function crewMerit(role: "search" | "write" | "verify", releaseCount: number): number {
  return role === "write" ? Math.min(4, Math.max(1, releaseCount)) : 2;
}

/** Whether a source ACTUALLY got paid — decided from the settlement outcome (money that moved),
 *  not the intended verdict. `settled` is the number of nanopayments that actually settled. A
 *  release whose nanopayments all failed (`settled === 0`) is NOT a release: the funds stayed in
 *  the budget and the live stream emitted a `refund`, so the run receipt must report it refunded
 *  too (`settlementFailed`), never a phantom `released:true`. The single source of truth the
 *  `summary` receipt uses so it can never diverge from what the chain actually did. */
export function summarizeRelease(
  releaseIntended: boolean,
  settled: number,
): { released: boolean; settlementFailed: boolean } {
  const released = settled > 0;
  return { released, settlementFailed: releaseIntended && !released };
}

/** Decide whether to pay a source, given whether it was cited, has a verifiable
 * identity, and whether its content actually supports the answer. */
export function decideVerdict(
  cited: boolean,
  verified: boolean,
  supported: boolean,
): { release: true } | { release: false; reasonKind: ReasonKind } {
  if (!cited) return { release: false, reasonKind: "uncited" };
  if (!verified) return { release: false, reasonKind: "identity" };
  if (!supported) return { release: false, reasonKind: "unsupported" };
  return { release: true };
}

/** Graded settlement (#1): how many fixed-price nanopayments a SUPPORTED citation earns, scaled by the
 *  Auditor's confidence (P-supported). A strongly-corroborated citation pays its full citation-frequency
 *  count; a borderline one pays proportionally fewer — but a supported citation always settles ≥1 (the
 *  floor) and never more than 5. Since x402 settles a fixed per-call price, confidence grades the COUNT of
 *  calls, not the price. At confidence 1.0 this equals the prior clamp(1,5,count). */
export function gradedNano(count: number, confidence: number): number {
  const graded = Math.round(Math.max(1, count) * Math.max(0, Math.min(1, confidence)));
  return Math.min(5, Math.max(1, graded));
}

/** Merit gained for a release (capped at +3). */
export function releaseMerit(settled: number): number {
  return Math.min(3, settled);
}

/** Merit lost for a refusal — identity-spoof is the worst. */
export function refundMerit(kind: ReasonKind): number {
  return kind === "identity" ? -6 : kind === "uncited" ? -4 : -3;
}

/** ERC-8004 feedback score written on-chain: paid = positive, refused = negative. */
export function repScore(release: boolean, kind?: ReasonKind): number {
  return release ? 100 : kind === "identity" ? -100 : kind === "uncited" ? -20 : -40;
}

/** Human-readable refusal reason shown in the UI + receipts. */
export function reasonFor(kind: ReasonKind): string {
  switch (kind) {
    case "uncited":
      return "Not cited — the agent judged the content irrelevant and excluded it from the answer.";
    case "identity":
      return "Failed verification — identity could not be authenticated on Arc.";
    case "unsupported":
      return "Failed verification — the cited text is not supported by the source.";
  }
}

/** Counterfactual feedback for a refusal (#2) — "what would have flipped it to a pay". The verdict-level
 *  kinds (uncited/identity) get a fixed, actionable hint; an unsupported citation defers to the
 *  citation-level counterfactual the Auditor computed (`citeCf`, from lib/llm.ts counterfactual()). */
export function counterfactualFor(kind: ReasonKind, citeCf?: string | null): string {
  if (kind === "uncited")
    return "Not cited — the agent judged this source irrelevant to the question; content that directly answers it would be cited and considered for payment.";
  if (kind === "identity")
    return "Identity unverified — register a wallet / ERC-8004 identity so a payment can be settled to you.";
  return citeCf || "The cited text isn't supported by the source — a source that actually states the claim would pass.";
}

/**
 * Reputation-gated dynamic pricing (#4). In a trust market a proven source commands a premium and an
 * unproven one discounts to win its first work and build reputation. Neutral merit (50) prices at base;
 * merit 100 → 1.5× base; merit 0 → 0.5× base — linear, clamped, 6-dp (USDC). Opt-in per source via
 * `priceMode` so existing fixed-price sources are unchanged; the SAME `effectivePrice` is used by the x402
 * seller quote, the agent's settlement, the budget, and the public view, so both sides of a payment agree.
 */
export function priceForMerit(base: number, merit: number): number {
  const m = Math.max(0, Math.min(100, merit));
  const factor = 0.5 + m / 100; // 0.5 .. 1.5
  return Math.round(base * factor * 1e6) / 1e6;
}

/** The price actually quoted + settled for a source — merit-gated only when the source opted in. */
export function effectivePrice(base: number, merit: number, priceMode?: string): number {
  return priceMode === "merit-gated" ? priceForMerit(base, merit) : base;
}

// ---- Verification-DEPTH pricing (B6) ----
// Price scales with verification depth: a cheap deterministic numeric screen < an NLI entailment check < the
// full adversarial judge. An agent discovers the tiers at /api/pricing and picks depth-vs-cost per call. This
// keeps pricing MOAT-native — you pay for how hard the verification tries, not for retrieval.
export type VerifyDepth = "numeric" | "nli" | "full";

/** Normalize an arbitrary input to a valid depth (default "full"). */
export function asDepth(d: unknown): VerifyDepth {
  return d === "numeric" || d === "nli" ? d : "full";
}

/** Which engine layers a depth tier runs. */
export function depthLayers(depth: VerifyDepth): { useNLI: boolean; useJudge: boolean } {
  if (depth === "numeric") return { useNLI: false, useJudge: false };
  if (depth === "nli") return { useNLI: true, useJudge: false };
  return { useNLI: true, useJudge: true }; // full
}

/** Per-verify price for a depth tier. Base (full) = MERIT_VERIFY_PRICE; shallower tiers cost proportionally less. */
export function verifyDepthPrice(depth: VerifyDepth): number {
  const full = Math.max(0.0001, Number(process.env.MERIT_VERIFY_PRICE) || 0.005);
  const factor = depth === "numeric" ? 0.2 : depth === "nli" ? 0.5 : 1;
  return Math.round(full * factor * 1e6) / 1e6;
}

/** The machine-readable verification price ladder — advertised at /api/pricing for agent-side discovery. */
export function verifyTiers() {
  const tiers: VerifyDepth[] = ["numeric", "nli", "full"];
  return tiers.map((d) => ({
    tier: d,
    price: verifyDepthPrice(d),
    gates: d === "numeric" ? ["numeric"] : d === "nli" ? ["numeric", "nli"] : ["numeric", "nli", "adversarial-judge"],
    description:
      d === "numeric"
        ? "Deterministic figure screen — catches a fabricated $/%/number with no model. Cheapest; a non-numeric claim returns 'needs a model'."
        : d === "nli"
          ? "Numeric + factual-consistency (NLI) — a real SUPPORTED/REFUSED from an entailment score, without the adversarial judge."
          : "Numeric + NLI + adversarial LLM judge — the full, injection-resistant gate.",
  }));
}

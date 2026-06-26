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

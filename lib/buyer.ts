/**
 * The API-discovery-and-buy agent (Phase 3 flagship). An agent that needs a claim backed doesn't just pick the
 * cheapest source — it picks the best VERIFIED-QUALITY-per-dollar one, buys it, and (this is the moat) pays only
 * if the delivered content actually verifies. A plain x402 directory ranks by price and latency; those are the
 * two things a rail can see. Merit adds the third dimension no rail can produce: a benchmarked verified-quality
 * signal — each source's measured citation-faithfulness over real settlements (lib/learn.reliability), blended
 * with its on-chain reputation. This file is the pure, testable RANKING; the route runs the actual procure +
 * verify + pay-only-if-verified loop over the ranking.
 */
import type { Source } from "./registry";
import { reliability, evidenceCount } from "./learn";
import { effectivePrice } from "./pricing";
import { round6 } from "./arc";

export interface Candidate {
  id: string;
  name: string;
  price: number; // effective USDC per use
  merit: number; // 0..100 on-chain reputation
  reliability: number; // 0..1 measured citation-faithfulness (the verified-quality signal)
  evidence: number; // observations behind `reliability` (how much to trust it)
  verifiedQuality: number; // 0..1 blended quality score
  valuePerDollar: number; // the rank key — verifiedQuality / price
}

/** Blend the measured verified-faithfulness (weighted most — it's the signal a rail can't compute) with on-chain
 *  reputation into a 0..1 quality score. A source with little evidence sits near the neutral prior (0.5). */
export function verifiedQuality(id: string, merit: number): number {
  const rel = reliability(id); // (0,1), pulls toward 0.5 with little evidence
  return round6(Math.max(0, Math.min(1, 0.2 + 0.6 * rel + 0.2 * (Math.max(0, Math.min(100, merit)) / 100))));
}

/** Rank buyable sources by verified-quality-per-dollar, best first. Pure — takes a snapshot of sources. */
export function rankCandidates(sources: Source[]): Candidate[] {
  return sources
    .filter((s) => s && s.content && s.content.length > 0)
    .map((s) => {
      const price = Math.max(0.000001, round6(effectivePrice(s.price, s.merit, s.priceMode)));
      const q = verifiedQuality(s.id, s.merit);
      return {
        id: s.id,
        name: s.name,
        price,
        merit: s.merit,
        reliability: round6(reliability(s.id)),
        evidence: evidenceCount(s.id),
        verifiedQuality: q,
        valuePerDollar: round6(q / price),
      };
    })
    .sort((a, b) => b.valuePerDollar - a.valuePerDollar);
}

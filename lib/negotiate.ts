/**
 * Agent-to-agent price negotiation (W4) — turns Merit's posted prices into a DECISION the lead makes.
 *
 * Given a seller's ask, the lead's budget-derived reservation (max willingness-to-pay), and the seller's
 * reputation, the lead either agrees within the zone of possible agreement (settling at a merit-weighted
 * split of the surplus) or WALKS AWAY when the seller's floor exceeds the reservation. Higher-merit sellers
 * hold firmer and capture more surplus. Pure + deterministic so the bargaining is unit-testable and visible
 * (the run emits `negotiate` events); the lead genuinely decides the price rather than reading a constant.
 */
import { round6 } from "./arc";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export interface NegotiationResult {
  agreed: boolean;
  price: number;
  rounds: number;
  reason: string;
}

export function negotiate(opts: {
  ask: number; // seller's opening price
  reservation: number; // the lead's max willingness-to-pay (budget-derived)
  sellerMerit: number; // 0..100 — higher merit concedes less and captures more surplus
  floor?: number; // seller's minimum acceptable price (defaults to ask discounted by its concession)
  maxRounds?: number;
}): NegotiationResult {
  const { ask, reservation } = opts;
  const concession = 0.25 * (1 - clamp01(opts.sellerMerit / 100)); // 0 (top merit) … 0.25 (no merit)
  const floor = opts.floor ?? round6(ask * (1 - concession));

  // Walk away when even the seller's floor exceeds what the lead will pay — a real refuse-to-hire decision.
  if (floor > reservation + 1e-9) {
    return {
      agreed: false,
      price: 0,
      rounds: 1,
      reason: `seller floor $${floor.toFixed(6)} exceeds reservation $${reservation.toFixed(6)} — walked away`,
    };
  }

  // ZOPA = [floor, min(ask, reservation)]; settle at a merit-weighted split of the surplus.
  const cap = Math.min(ask, reservation);
  const sellerShare = clamp01(0.4 + 0.5 * (opts.sellerMerit / 100)); // 0.4 … 0.9
  const price = round6(floor + (cap - floor) * sellerShare);
  const gap = ask > reservation ? ask - reservation : 0;
  const rounds = Math.min(opts.maxRounds ?? 3, 1 + (gap > 0 ? 1 : 0) + (concession > 0.1 ? 1 : 0));
  return { agreed: true, price, rounds, reason: `agreed at $${price.toFixed(6)} after ${rounds} round(s)` };
}

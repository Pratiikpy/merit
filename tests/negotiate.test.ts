import { describe, it, expect } from "vitest";
import { negotiate } from "../lib/negotiate";

describe("agent-to-agent price negotiation (W4)", () => {
  it("agrees within the budget when the ask is affordable", () => {
    const r = negotiate({ ask: 0.01, reservation: 0.5, sellerMerit: 90 });
    expect(r.agreed).toBe(true);
    expect(r.price).toBeGreaterThan(0);
    expect(r.price).toBeLessThanOrEqual(0.5); // never exceeds the reservation
    expect(r.price).toBeLessThanOrEqual(0.01 + 1e-9); // never above the ask
  });

  it("WALKS AWAY when the seller's floor exceeds the reservation", () => {
    const r = negotiate({ ask: 1.0, reservation: 0.1, sellerMerit: 95 }); // tiny concession → floor ≈ 0.988
    expect(r.agreed).toBe(false);
    expect(r.price).toBe(0);
    expect(r.reason).toMatch(/walked away/);
  });

  it("a higher-merit seller captures more surplus (settles higher)", () => {
    const lo = negotiate({ ask: 0.02, reservation: 0.05, sellerMerit: 40 });
    const hi = negotiate({ ask: 0.02, reservation: 0.05, sellerMerit: 95 });
    expect(lo.agreed && hi.agreed).toBe(true);
    expect(hi.price).toBeGreaterThan(lo.price);
  });

  it("the settled price always stays within [floor, reservation]", () => {
    const r = negotiate({ ask: 0.03, reservation: 0.04, sellerMerit: 70 });
    expect(r.agreed).toBe(true);
    expect(r.price).toBeLessThanOrEqual(0.04);
    expect(r.price).toBeGreaterThan(0);
    expect(r.rounds).toBeGreaterThanOrEqual(1);
  });
});

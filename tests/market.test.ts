import { describe, it, expect } from "vitest";
import { blendPrior } from "../lib/market";

describe("prediction-market prior blend (#18)", () => {
  it("weight 0 ignores the market; weight 1 trusts it fully", () => {
    expect(blendPrior(0.8, 2000, 0)).toBeCloseTo(0.8, 6); // ignore the market
    expect(blendPrior(0.8, 2000, 1)).toBeCloseTo(0.2, 6); // fully the market (2000 bps = 0.2)
  });
  it("blends linearly and clamps confidence + probability", () => {
    expect(blendPrior(0.6, 8000, 0.5)).toBeCloseTo(0.7, 6); // (0.6 + 0.8) / 2
    expect(blendPrior(2, 12000, 0.5)).toBeCloseTo(1, 6); // both clamped to 1
  });
});

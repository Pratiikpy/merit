import { describe, it, expect } from "vitest";
import { quotePremium } from "../lib/insurance";

describe("insurance premium pricing (#17)", () => {
  it("a high-reputation source is cheap to guarantee; a low-rep one is expensive", () => {
    expect(quotePremium(100, 100)).toBeCloseTo(1, 6); // 100 × 0.05 × 0.2
    expect(quotePremium(100, 50)).toBeCloseTo(3.5, 6); // 100 × 0.05 × 0.7
    expect(quotePremium(100, 0)).toBeCloseTo(6, 6); // 100 × 0.05 × 1.2
    expect(quotePremium(100, 90)).toBeLessThan(quotePremium(100, 40)); // monotonic: more reputation → cheaper
  });
  it("clamps reputation to 0..100 and scales linearly with coverage", () => {
    expect(quotePremium(100, 150)).toBeCloseTo(1, 6); // clamped at 100
    expect(quotePremium(200, 100)).toBeCloseTo(2, 6); // 2× coverage → 2× premium
  });
});

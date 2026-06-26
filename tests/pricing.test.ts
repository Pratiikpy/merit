import { describe, it, expect } from "vitest";
import { priceForMerit, effectivePrice } from "../lib/pricing";

describe("priceForMerit (reputation-gated dynamic pricing, #4)", () => {
  it("neutral merit (50) prices at base; 100 → 1.5×; 0 → 0.5×", () => {
    expect(priceForMerit(0.01, 50)).toBeCloseTo(0.01, 9);
    expect(priceForMerit(0.01, 100)).toBeCloseTo(0.015, 9);
    expect(priceForMerit(0.01, 0)).toBeCloseTo(0.005, 9);
  });
  it("clamps merit to 0..100 and rounds to 6dp", () => {
    expect(priceForMerit(0.009, 95)).toBe(0.01305);
    expect(priceForMerit(0.01, 150)).toBeCloseTo(0.015, 9); // clamped at 100
    expect(priceForMerit(0.01, -20)).toBeCloseTo(0.005, 9); // clamped at 0
  });
});

describe("effectivePrice (opt-in via priceMode)", () => {
  it("merit-gated applies the curve; fixed (or unset) returns the base price", () => {
    expect(effectivePrice(0.009, 95, "merit-gated")).toBe(0.01305);
    expect(effectivePrice(0.009, 95, "fixed")).toBe(0.009);
    expect(effectivePrice(0.009, 95)).toBe(0.009); // default = fixed (existing sources unchanged)
  });
});

import { describe, it, expect } from "vitest";
import { GOLD, goldSummary } from "../lib/goldset";

// The gold set is the shared source of truth for `npm run judge-eval` AND the public moat counters
// (/api/honesty, /api/benchmark, /api/bounty). This test pins its composition so the numbers a judge reads
// on the live site can never silently drift from the set the benchmark is actually scored against.
describe("gold set — the published proof-of-citation benchmark", () => {
  it("is the fixed, balanced 16-pair set (9 adversarial / 7 supported)", () => {
    expect(GOLD.length).toBe(16);
    const refused = GOLD.filter((g) => g.expect === "REFUSED").length;
    const supported = GOLD.filter((g) => g.expect === "SUPPORTED").length;
    expect(refused).toBe(9);
    expect(supported).toBe(7);
    expect(refused + supported).toBe(GOLD.length);
  });

  it("every pair has a source, a substantive claim, and a valid expected verdict", () => {
    for (const g of GOLD) {
      expect(g.source).toBeTruthy();
      expect(g.claim.length).toBeGreaterThan(10);
      expect(["SUPPORTED", "REFUSED"]).toContain(g.expect);
    }
  });

  it("summary surfaces the gold-set composition + an HONEST (measured-or-pending) benchmark, never a hardcoded 100%", () => {
    const s = goldSummary();
    expect(s).toMatchObject({ goldSet: 16, adversarial: 9, supported: 7 });
    expect(typeof s.measured).toBe("boolean");
    if (s.measured) {
      expect(s.precisionRecall).toMatch(/precision\/recall/);
    } else {
      expect(s.precisionRecall).toMatch(/not yet measured/i);
      expect(s.foolRate).toBeNull();
      expect(s.attacksHeld).toBe(0);
    }
  });
});

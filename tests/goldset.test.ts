import { describe, it, expect } from "vitest";
import { GOLD, goldSummary } from "../lib/goldset";

// The gold set is the shared source of truth for `npm run judge-eval` AND the public moat counters
// (/api/honesty, /api/benchmark, /api/bounty). This test pins its composition so the numbers a judge reads
// on the live site can never silently drift from the set the benchmark is actually scored against.
describe("gold set — the published proof-of-citation benchmark", () => {
  it("is the fixed 275-pair adversarial set (205 must-refuse / 70 must-support), all 14 failure modes present", () => {
    expect(GOLD.length).toBe(275);
    const refused = GOLD.filter((g) => g.expect === "REFUSED").length;
    const supported = GOLD.filter((g) => g.expect === "SUPPORTED").length;
    expect(refused).toBe(205);
    expect(supported).toBe(70);
    expect(refused + supported).toBe(GOLD.length);
    // every adversarial failure mode is represented (no silently-dropped attack class)
    const modes = new Set(GOLD.map((g) => g.failureMode));
    for (const m of ["fabricated-figure", "direct-contradiction", "off-topic", "right-entity-wrong-attribute", "overgeneralization", "temporal-error", "negation-and-causation-flip", "unsupported-addition", "prompt-injection-in-claim", "supported-direct", "supported-paraphrase"]) {
      expect(modes.has(m)).toBe(true);
    }
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
    expect(s).toMatchObject({ goldSet: 275, adversarial: 205, supported: 70 });
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

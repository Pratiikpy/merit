import { describe, expect, it } from "vitest";
import { asDepth, depthLayers, verifyDepthPrice, verifyTiers } from "../lib/pricing";
import { isVerifyError, verifyCitation } from "../lib/verify/engine";

describe("verification-depth pricing (B6)", () => {
  it("normalizes depth and maps layers", () => {
    expect(asDepth("numeric")).toBe("numeric");
    expect(asDepth("nli")).toBe("nli");
    expect(asDepth("full")).toBe("full");
    expect(asDepth("garbage")).toBe("full"); // default
    expect(asDepth(undefined)).toBe("full");
    expect(depthLayers("numeric")).toEqual({ useNLI: false, useJudge: false });
    expect(depthLayers("nli")).toEqual({ useNLI: true, useJudge: false });
    expect(depthLayers("full")).toEqual({ useNLI: true, useJudge: true });
  });

  it("prices shallower tiers cheaper than full", () => {
    const full = verifyDepthPrice("full");
    const nli = verifyDepthPrice("nli");
    const numeric = verifyDepthPrice("numeric");
    expect(numeric).toBeLessThan(nli);
    expect(nli).toBeLessThan(full);
    const tiers = verifyTiers();
    expect(tiers.map((t) => t.tier)).toEqual(["numeric", "nli", "full"]);
    expect(tiers[2].gates).toContain("adversarial-judge");
    expect(tiers[0].gates).toEqual(["numeric"]);
  });
});

describe("engine useJudge depth (B6)", () => {
  it("numeric-only still REFUSES a fabricated figure (no model needed)", async () => {
    const out = await verifyCitation(
      "StableData reported $40 trillion in annualized settlement volume in 2026.",
      "The StableData index shows cross-border settlement reached $4.1 trillion in annualized volume in 2026.",
      { useNLI: false, useJudge: false, sign: false },
    );
    expect(isVerifyError(out)).toBe(false);
    if (!isVerifyError(out)) {
      expect(out.verdict.verdict).toBe("REFUSED");
      expect(out.verdict.gates?.numeric.ran).toBe(true);
      expect(out.verdict.gates?.judge.ran).toBe(false); // the judge was skipped for this depth
    }
  });

  it("numeric-only on a non-numeric claim returns the honest 'needs a model' 503 (no fabrication to catch)", async () => {
    const out = await verifyCitation(
      "The Eiffel Tower is a landmark in Paris.",
      "The Eiffel Tower is a wrought-iron lattice tower in Paris, France.",
      { useNLI: false, useJudge: false, sign: false },
    );
    expect(isVerifyError(out)).toBe(true);
    if (isVerifyError(out)) expect(out.numericOnly).toBe(true);
  });
});

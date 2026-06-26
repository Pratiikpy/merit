import { describe, it, expect } from "vitest";
import { parsePolicy, sourceAllowed, releaseHold } from "../lib/policy";

describe("parsePolicy (sanitize an untrusted policy)", () => {
  it("keeps valid fields, drops junk, clamps the refund ratio", () => {
    expect(
      parsePolicy({ allowlist: ["a", 2, "b"], perSourceCap: 0.05, approvalThreshold: 0.1, maxRefundRatio: 2 }),
    ).toEqual({ allowlist: ["a", "b"], perSourceCap: 0.05, approvalThreshold: 0.1, maxRefundRatio: 1 });
    expect(parsePolicy(null)).toEqual({});
    expect(parsePolicy({ perSourceCap: -1 })).toEqual({}); // negative dropped
  });
});

describe("sourceAllowed (allowlist)", () => {
  it("allows all with no allowlist; matches id or name case-insensitively", () => {
    expect(sourceAllowed({}, "x", "X Source")).toBe(true);
    expect(sourceAllowed({ allowlist: ["stabledata"] }, "stabledata", "StableData API")).toBe(true);
    expect(sourceAllowed({ allowlist: ["StableData API"] }, "stabledata", "StableData API")).toBe(true);
    expect(sourceAllowed({ allowlist: ["other"] }, "stabledata", "StableData API")).toBe(false);
  });
});

describe("releaseHold (settlement-time guardrails)", () => {
  it("holds above a per-source cap", () => {
    expect(releaseHold({ perSourceCap: 0.02 }, 0.03, 0, 0.5)?.kind).toBe("cap");
    expect(releaseHold({ perSourceCap: 0.02 }, 0.02, 0, 0.5)).toBeNull();
  });
  it("holds above the approval threshold", () => {
    expect(releaseHold({ approvalThreshold: 0.05 }, 0.06, 0, 0.5)?.kind).toBe("approval");
  });
  it("holds once refunds exceed the max ratio", () => {
    expect(releaseHold({ maxRefundRatio: 0.2 }, 0.01, 0.2, 0.5)?.kind).toBe("refund-ratio"); // 0.2/0.5 = 0.4 > 0.2
    expect(releaseHold({ maxRefundRatio: 0.5 }, 0.01, 0.2, 0.5)).toBeNull(); // 0.4 < 0.5
  });
  it("no policy → never holds", () => {
    expect(releaseHold({}, 1, 1, 0.5)).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { parseRslLicense, attributionProof } from "../lib/rsl";

describe("RSL / Tollbit adapter (W4 — the proof layer above the toll)", () => {
  it("parses an RSL license declaration", () => {
    const l = parseRslLicense("RSL license=https://rslstandard.org/ai-train; payto=0xabc123; amount=0.01; currency=USDC");
    expect(l).not.toBeNull();
    expect(l!.standard).toBe("RSL");
    expect(l!.license).toBe("https://rslstandard.org/ai-train");
    expect(l!.payTo).toBe("0xabc123");
    expect(l!.amount).toBeCloseTo(0.01, 6);
    expect(l!.currency).toBe("USDC");
  });

  it("recognizes a TollBit declaration and ignores non-license headers", () => {
    expect(parseRslLicense("TollBit price=0.02; payto=0xdef")?.standard).toBe("TollBit");
    expect(parseRslLicense("")).toBeNull();
    expect(parseRslLicense("Mozilla/5.0")).toBeNull();
  });

  it("emits a settlement instruction ONLY for a supported citation", () => {
    const lic = parseRslLicense("RSL license=x; payto=0xabc; amount=0.01; currency=USDC");
    const yes = attributionProof({ sourceId: "s1", claim: "the $4.1T claim", supported: true, confidence: 0.8, license: lic });
    expect(yes.settle).not.toBeNull();
    expect(yes.settle!.payTo).toBe("0xabc");
    expect(yes.settle!.amount).toBeCloseTo(0.01, 6);

    const no = attributionProof({ sourceId: "s1", claim: "a false claim", supported: false, confidence: 0.1, license: lic });
    expect(no.settle).toBeNull(); // refused → no payment, but the proof is still produced
    expect(no.note).toMatch(/not supported/i);
  });

  it("defaults currency + standard when the license is sparse/absent", () => {
    const p = attributionProof({ sourceId: "s", claim: "c", supported: true, confidence: 0.7, license: null });
    expect(p.standard).toBe("RSL");
    expect(p.settle!.currency).toBe("USDC");
  });
});

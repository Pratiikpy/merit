import { describe, it, expect, beforeAll } from "vitest";

// Offline engine tests: the numeric verifier + input validation need no keys/models, so they're fully
// deterministic. Keys are cleared before import so the LLM-judge path stays out of these cases.
let engine: typeof import("../lib/verify/engine");
beforeAll(async () => {
  process.env.STUB = "1";
  delete process.env.LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.MERIT_NLI_URL;
  engine = await import("../lib/verify/engine");
}, 60000);

describe("verifyCitation engine (M1)", () => {
  it("REFUSES a fabricated numeric claim deterministically (no LLM, no NLI)", async () => {
    const out = await engine.verifyCitation(
      "The market hit $40 trillion in daily volume.",
      "Reports show the market reached $4.1 trillion in daily volume.",
      { sign: false, useNLI: false },
    );
    expect(engine.isVerifyError(out)).toBe(false);
    if (!engine.isVerifyError(out)) {
      expect(out.verdict.verdict).toBe("REFUSED");
      expect(out.verdict.grounded).toBe(false);
      expect(out.verdict.score).toBe(0);
      expect(out.verdict.methods).toContain("numeric");
      expect(out.verdict.schema).toBe("merit.cvo/v2");
      expect(out.verdict.sourceHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(out.verdict.engineVersion).toBe(engine.ENGINE_VERSION);
    }
  });

  it("rejects empty input with 400", async () => {
    const out = await engine.verifyCitation("", "", { sign: false });
    expect(engine.isVerifyError(out)).toBe(true);
    if (engine.isVerifyError(out)) expect(out.status).toBe(400);
  });

  it("rejects oversized input with 400", async () => {
    const out = await engine.verifyCitation("x".repeat(5000), "some source", { sign: false });
    expect(engine.isVerifyError(out)).toBe(true);
    if (engine.isVerifyError(out)) expect(out.status).toBe(400);
  });

  it("does not fabricate-flag a numeric claim the source corroborates within tolerance", async () => {
    // $4 trillion vs $4.1 trillion is within the 50% support tolerance → numeric layer does NOT refuse;
    // with no NLI + no LLM key this is undecidable → honest 503 (numericOnly), never a false REFUSED.
    const out = await engine.verifyCitation(
      "The market reached $4 trillion in volume.",
      "Reports show the market reached $4.1 trillion in daily volume.",
      { sign: false, useNLI: false },
    );
    expect(engine.isVerifyError(out)).toBe(true);
    if (engine.isVerifyError(out)) {
      expect(out.status).toBe(503);
      expect(out.numericOnly).toBe(true);
    }
  });
});

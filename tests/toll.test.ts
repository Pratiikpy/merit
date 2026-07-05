import { describe, it, expect } from "vitest";
import { evaluateToll, tollStats, TOLL_PRICE_DEFAULT } from "../lib/toll";

describe("Verified Citation Toll gate", () => {
  it("400s without a claim", async () => {
    const r = await evaluateToll({ claim: "" });
    expect("error" in r && r.status).toBe(400);
  });

  it("400s without a passage or URL", async () => {
    const r = await evaluateToll({ claim: "USDC supply is 61B" });
    expect("error" in r && r.status).toBe(400);
  });

  it("REFUSES a citation whose figure the source contradicts (deterministic numeric gate, keyless)", async () => {
    // fabricated figure: claim says $9B, source says $3B — the numeric gate catches this with no model
    const r = await evaluateToll({
      claim: "The company reported $9 billion in revenue.",
      citedPassage: "In the filing, the company reported $3 billion in revenue for the period.",
      tollUsdc: 0.002,
      publisher: "ExampleWire",
      record: false,
    });
    expect("receipt" in r).toBe(true);
    if (!("receipt" in r)) return;
    expect(r.receipt.verdict).toBe("REFUSED");
    expect(r.receipt.decision).toBe("refuse");
    expect(r.receipt.released).toBe(0); // do NOT pay for an unsupported citation
    expect(r.receipt.tollUsdc).toBe(0.002);
    expect(r.receipt.methods).toContain("numeric");
  });

  it("defaults the toll and records the honesty split", async () => {
    const before = tollStats();
    const r = await evaluateToll({
      claim: "Revenue was $50 billion.",
      citedPassage: "Revenue was $2 billion in the quarter.",
      record: true,
    });
    expect("receipt" in r).toBe(true);
    if (!("receipt" in r)) return;
    expect(r.receipt.tollUsdc).toBe(TOLL_PRICE_DEFAULT);
    const after = tollStats();
    expect(after.gates).toBe(before.gates + 1);
    expect(after.refused).toBe(before.refused + 1);
    expect(after.savedUsdc).toBeGreaterThanOrEqual(before.savedUsdc); // a refused citation is money NOT wrongly paid
  });

  it("signs the verdict as merit.toll/v1", async () => {
    const r = await evaluateToll({
      claim: "Growth was 900%.",
      citedPassage: "Growth was 9% year over year.",
      record: false,
    });
    if (!("receipt" in r)) throw new Error("expected receipt");
    expect(r.receipt.schema).toBe("merit.toll/v1");
  });
});

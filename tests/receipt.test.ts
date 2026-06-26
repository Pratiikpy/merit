import { describe, it, expect } from "vitest";
import { canonicalize, signReceiptWith, verifyReceipt } from "../lib/receipt";

// A well-known public test private key (Hardhat account #0) — for the signing roundtrip only.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("receipt signing (self-proving receipts)", () => {
  it("canonicalize is deterministic — recursively sorts keys", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(canonicalize([{ y: 1, x: 2 }])).toBe('[{"x":2,"y":1}]');
  });

  it("a signed receipt verifies, and any tamper to a verdict or amount breaks it", async () => {
    const body = {
      question: "what is driving adoption?",
      budget: 0.5,
      totals: { released: 0.02, refunded: 0.01, labor: 0.006 },
      sources: [
        { name: "StableData API", released: true, amount: 0.02 },
        { name: "Anon Substack", released: false },
      ],
    };
    const { signer, signature } = await signReceiptWith(TEST_KEY, body);
    expect((await verifyReceipt({ ...body, signer, signature })).ok).toBe(true);

    // Tamper: flip a refusal into a payment → the recovered signer no longer matches.
    const tampered = { ...body, sources: [body.sources[0], { name: "Anon Substack", released: true, amount: 0.02 }], signer, signature };
    expect((await verifyReceipt(tampered)).ok).toBe(false);

    // Tamper: inflate a total → also breaks.
    const inflated = { ...body, totals: { ...body.totals, released: 999 }, signer, signature };
    expect((await verifyReceipt(inflated)).ok).toBe(false);
  });

  it("an unsigned receipt does not falsely verify", async () => {
    expect((await verifyReceipt({ question: "q", totals: {} })).ok).toBe(false);
  });
});

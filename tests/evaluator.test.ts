import { describe, it, expect } from "vitest";
import { evaluate, evaluatorStats, ESCROW_DEFAULT } from "../lib/evaluator";

describe("ERC-8183 evaluator-of-record", () => {
  it("400s without a brief or deliverable", async () => {
    expect("error" in (await evaluate({ brief: "", deliverable: "x" }))).toBe(true);
    expect("error" in (await evaluate({ brief: "x", deliverable: "" }))).toBe(true);
  });

  it("RELEASES when the deliverable meets the requirements (deterministic offline grade)", async () => {
    const r = await evaluate({
      brief: "Summarize how USDC settles on Arc.",
      requirements: ["mentions USDC", "mentions Arc settlement"],
      deliverable: "USDC settles on Arc with sub-second finality; every Arc settlement is native USDC.",
      escrowUsdc: 0.05,
      jobRef: "job-42",
      allowOffline: true,
      record: false,
    });
    expect("receipt" in r).toBe(true);
    if (!("receipt" in r)) return;
    expect(r.receipt.decision).toBe("release");
    expect(r.receipt.accepted).toBe(true);
    expect(r.receipt.released).toBe(0.05);
    expect(r.receipt.certificate.schema).toBe("merit.gig/v1");
  });

  it("REFUNDS when the deliverable does not meet the requirements — escrow is NOT released", async () => {
    const r = await evaluate({
      brief: "Explain Bitcoin proof-of-work mining difficulty.",
      requirements: ["explains proof-of-work", "explains mining difficulty adjustment"],
      deliverable: "Bananas are a good source of potassium and grow in tropical climates.",
      escrowUsdc: 0.05,
      allowOffline: true,
      record: true,
    });
    expect("receipt" in r).toBe(true);
    if (!("receipt" in r)) return;
    expect(r.receipt.decision).toBe("refund");
    expect(r.receipt.accepted).toBe(false);
    expect(r.receipt.released).toBe(0);
  });

  it("is deterministic — the same deliverable re-grades to the same verdict + hash (dispute path)", async () => {
    const input = {
      brief: "State the USDC total supply figure.",
      requirements: ["states a USDC total supply figure"],
      deliverable: "USDC total supply is about 61 billion dollars across chains.",
      allowOffline: true,
    };
    const a = await evaluate(input);
    const b = await evaluate(input);
    if (!("receipt" in a) || !("receipt" in b)) throw new Error("expected receipts");
    expect(a.receipt.deliverableHash).toBe(b.receipt.deliverableHash);
    expect(a.receipt.decision).toBe(b.receipt.decision);
  });

  it("records the accept/reject split", async () => {
    const s = evaluatorStats();
    expect(s.evals).toBeGreaterThanOrEqual(1); // the reject case above recorded
    expect(typeof s.heldUsdc).toBe("number");
  });
});

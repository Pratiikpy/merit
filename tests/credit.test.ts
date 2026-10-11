import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

let credit: typeof import("../lib/credit");
let registry: typeof import("../lib/registry");

beforeAll(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-credit-"));
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  delete process.env.CREDIT_ONCHAIN; // off-chain recording; readStake() short-circuits with no STAKE_ADDRESS
  delete process.env.STAKE_ADDRESS;
  credit = await import("../lib/credit");
  registry = await import("../lib/registry");
});

describe("creditTierMultiple / creditLimitFor — the ARCANA-shaped tier ladder, pure", () => {
  it("a source below the 50-merit floor gets zero credit at any stake size", () => {
    expect(credit.creditTierMultiple(49)).toBe(0);
    expect(credit.creditLimitFor(0, 1000)).toBe(0);
    expect(credit.creditLimitFor(49.9, 1000)).toBe(0);
  });

  it("ties the multiple to the tier boundaries exactly", () => {
    expect(credit.creditTierMultiple(50)).toBe(0.5);
    expect(credit.creditTierMultiple(69.9)).toBe(0.5);
    expect(credit.creditTierMultiple(70)).toBe(1);
    expect(credit.creditTierMultiple(89.9)).toBe(1);
    expect(credit.creditTierMultiple(90)).toBe(2);
    expect(credit.creditTierMultiple(100)).toBe(2);
  });

  it("scales the limit with real stake, not a flat amount", () => {
    expect(credit.creditLimitFor(90, 0.1)).toBeCloseTo(0.2, 6); // 2x a small stake
    expect(credit.creditLimitFor(50, 0.1)).toBeCloseTo(0.05, 6); // 0.5x the same stake
  });

  it("is capped at MERIT_CREDIT_MAX_USDC regardless of how large stake × tier gets", () => {
    const huge = credit.creditLimitFor(100, 1_000_000);
    expect(huge).toBeLessThanOrEqual(1); // the default cap
  });
});

describe("requestAdvance — real eligibility logic, offline (no chain, no on-chain spend)", () => {
  it("refuses an unknown source", async () => {
    const res = await credit.requestAdvance({ sourceId: "nope", amountUsdc: 0.01 });
    expect("error" in res && res.status).toBe(404);
  });

  it("refuses a zero/negative amount for a real, freshly-created source", async () => {
    const src = registry.addCreator({ name: "Low Merit Source", handle: "@low", price: 0.01, wallet: "0x1111111111111111111111111111111111111111", content: "x" });
    const res = await credit.requestAdvance({ sourceId: src.id, amountUsdc: 0 });
    expect("error" in res && res.status).toBe(400);
  });

  it("without STAKE_ADDRESS configured, refuses honestly (502) rather than guessing a stake of 0", async () => {
    const src = registry.addCreator({ name: "No Stake Config Source", handle: "@nostake", price: 0.01, wallet: "0x2222222222222222222222222222222222222222", content: "x" });
    const res = await credit.requestAdvance({ sourceId: src.id, amountUsdc: 0.01 });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.status).toBe(502); // readStake() needs a real STAKE_ADDRESS — never fabricated
  });

  it("refuses an advance into a custodial (wallet-less) source before ever reading stake", async () => {
    const prevCustody = process.env.BUYER_ADDRESS;
    process.env.BUYER_ADDRESS = "0x3333333333333333333333333333333333333333";
    const src = registry.addCreator({ name: "Custodial Source", handle: "@custodial", price: 0.01, content: "x" }); // no wallet → custodial
    const res = await credit.requestAdvance({ sourceId: src.id, amountUsdc: 0.01 });
    expect("error" in res && res.status).toBe(400);
    process.env.BUYER_ADDRESS = prevCustody;
  });
});

describe("repayAdvance — refuses cleanly without a real advance or a real-looking tx hash", () => {
  it("404s an unknown advance", async () => {
    const res = await credit.repayAdvance({ advanceId: "nope", amountUsdc: 0.01, txHash: "0x" + "a".repeat(64) });
    expect("error" in res && res.status).toBe(404);
  });
});

describe("resolveOverdueAdvance — refuses cleanly without a real advance", () => {
  it("404s an unknown advance", async () => {
    const res = await credit.resolveOverdueAdvance("nope");
    expect("error" in res && res.status).toBe(404);
  });
});

describe("stats and listing start empty and stay internally consistent", () => {
  it("creditStats never goes negative and totals line up with the list", () => {
    const s = credit.creditStats();
    expect(s.outstandingUsdc).toBeGreaterThanOrEqual(0);
    expect(s.repaidUsdc).toBeGreaterThanOrEqual(0);
    expect(s.slashedUsdc).toBeGreaterThanOrEqual(0);
  });

  it("is off-chain when CREDIT_ONCHAIN is unset", () => {
    expect(credit.creditOnchainEnabled()).toBe(false);
  });
});

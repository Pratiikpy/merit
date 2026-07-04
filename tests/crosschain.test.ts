import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

let cc: typeof import("../lib/crosschain");

beforeAll(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-cc-"));
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  delete process.env.BUYER_PRIVATE_KEY; // keyless → payout unavailable (honest 503), balance null
  delete process.env.CIRCLE_API_KEY; // compliance uses the local fallback
  cc = await import("../lib/crosschain");
});

const GOOD = "0x1111111111111111111111111111111111111111";

describe("cross-chain payout", () => {
  it("lists the supported Circle Gateway chains", () => {
    const chains = cc.supportedPayoutChains().map((c) => c.chain);
    expect(chains).toContain("baseSepolia");
    expect(chains).toContain("arbitrumSepolia");
    expect(chains).toContain("arcTestnet");
  });

  it("rejects a non-positive amount", async () => {
    const r = await cc.crossChainPayout({ amount: 0, chain: "baseSepolia", recipient: GOOD });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects an unsupported chain", async () => {
    const r = await cc.crossChainPayout({ amount: 1, chain: "ethereumMainnet", recipient: GOOD });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects an invalid recipient address", async () => {
    const r = await cc.crossChainPayout({ amount: 1, chain: "baseSepolia", recipient: "not-an-address" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("fails CLOSED (503) with an honest message on a keyless/stub deployment — never a fake transfer", async () => {
    const r = await cc.crossChainPayout({ amount: 0.05, chain: "baseSepolia", recipient: GOOD });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.error).toMatch(/unavailable|full code path/i);
    }
  });

  it("reports no gateway balance and no payouts when keyless", async () => {
    expect(await cc.gatewayBalance()).toBeNull();
    expect(cc.recentPayouts()).toEqual([]);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

let market: typeof import("../lib/market");

beforeAll(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-market-"));
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  delete process.env.MARKET_ONCHAIN; // off-chain resolution by the same verdict
  delete process.env.LLM_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.OPENAI_API_KEY;
  market = await import("../lib/market");
});

describe("verification-resolved prediction market", () => {
  it("validates the market inputs", async () => {
    const a = await market.createMarket({ claim: "", source: "s" });
    expect("error" in a && a.status).toBe(400);
    const b = await market.createMarket({ claim: "c", source: "" });
    expect("error" in b && b.status).toBe(400);
  });

  it("creates an open market with a stable bytes32 id and a 50/50 starting probability", async () => {
    const res = await market.createMarket({ claim: "Settlement crossed $4.1 trillion in 2026.", source: "The report states settlement crossed $4.1 trillion in 2026." });
    expect("market" in res).toBe(true);
    if ("market" in res) {
      expect(res.market.status).toBe("open");
      expect(res.market.marketId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(res.market.yesBps).toBe(5000);
      expect(res.market.sourcePreview.length).toBeGreaterThan(0);
      expect(market.getMarket(res.market.id)?.claim).toContain("4.1 trillion");
    }
  });

  it("resolves by GROUND TRUTH: a claim the source contradicts settles NO (deterministic, no LLM)", async () => {
    const created = await market.createMarket({ claim: "Settlement reached $40 trillion in 2026.", source: "The report states settlement reached $4.1 trillion in 2026." });
    if (!("market" in created)) throw new Error("create failed");
    const res = await market.resolveMarket(created.market.id);
    expect("market" in res).toBe(true);
    if ("market" in res) {
      expect(res.market.status).toBe("resolved");
      expect(res.market.outcome).toBe("NO"); // the source contradicts the claim → it does NOT verify
      expect(res.market.verificationId).toMatch(/^0x[0-9a-f]{64}$/); // the signed verdict that resolved it
    }
  });

  it("resolves NO for an off-topic claim (below the similarity floor)", async () => {
    const created = await market.createMarket({ claim: "The capital of France is Paris.", source: "Bananas grow in tropical climates and are rich in potassium." });
    if (!("market" in created)) throw new Error("create failed");
    const res = await market.resolveMarket(created.market.id);
    if ("market" in res) expect(res.market.outcome).toBe("NO");
  });

  it("404s an unknown market and 409s a re-resolve", async () => {
    const r404 = await market.resolveMarket("nope");
    expect("error" in r404 && r404.status).toBe(404);
    const created = await market.createMarket({ claim: "X was $9 trillion.", source: "X was $1 trillion." });
    if (!("market" in created)) throw new Error("create failed");
    await market.resolveMarket(created.market.id);
    const again = await market.resolveMarket(created.market.id);
    expect("error" in again && again.status).toBe(409);
  });

  it("tracks stats (total / open / resolved / verifiedYes)", () => {
    const s = market.marketStats();
    expect(s.total).toBeGreaterThan(0);
    expect(s.resolved).toBeGreaterThan(0);
    expect(s.verifiedYes).toBe(0); // nothing verified YES in these deterministic-refuse tests
  });
});

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { assetMeta, settlementAsset, toAtomic, cctpConfigured } from "../lib/assets";
import { ARC } from "../lib/arc";

const ENV = ["EURC_ADDRESS", "MERIT_ASSET", "CCTP_API", "CCTP_TOKEN_MESSENGER"];

describe("lib/assets (USDC default + EURC/CCTP gated drop-ins)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterAll(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("USDC is always enabled at Arc's native address; EURC is disabled until configured", () => {
    const u = assetMeta("USDC");
    expect(u.enabled).toBe(true);
    expect(u.address).toBe(ARC.usdc);
    expect(assetMeta("EURC").enabled).toBe(false);
  });

  it("settlementAsset stays USDC unless EURC is both requested AND configured", () => {
    expect(settlementAsset()).toBe("USDC");
    process.env.MERIT_ASSET = "EURC";
    expect(settlementAsset()).toBe("USDC"); // requested but not configured → fall back
    process.env.EURC_ADDRESS = "0x" + "e".repeat(40);
    expect(settlementAsset()).toBe("EURC");
    expect(assetMeta("EURC").enabled).toBe(true);
  });

  it("toAtomic uses 6 decimals for both assets", () => {
    expect(toAtomic(0.01)).toBe(10000n);
    expect(toAtomic(1.5, "EURC")).toBe(1500000n);
    expect(toAtomic(-5)).toBe(0n); // clamped
  });

  it("cctpConfigured reflects the env (gated)", () => {
    expect(cctpConfigured()).toBe(false);
    process.env.CCTP_API = "https://iris-api-sandbox.circle.com";
    expect(cctpConfigured()).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { walletMode, deriveWallet, circleDcwConfigured, provisionWallet } from "../lib/wallet";

const ENV = ["MERIT_WALLET", "MERIT_WALLET_SEED", "CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET"];

describe("lib/wallet (per-principal wallet abstraction)", () => {
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

  it("defaults to eoa mode; circle-dcw when MERIT_WALLET is set", () => {
    expect(walletMode()).toBe("eoa");
    process.env.MERIT_WALLET = "circle-dcw";
    expect(walletMode()).toBe("circle-dcw");
  });

  it("derives a deterministic, unique address per principal", () => {
    const a1 = deriveWallet("prin_a");
    const a2 = deriveWallet("prin_a");
    const b = deriveWallet("prin_b");
    expect(a1.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(a1.address).toBe(a2.address); // deterministic — recomputable, nothing to store
    expect(a1.address).not.toBe(b.address); // isolated per principal (no shared EOA)
    expect(a1.mode).toBe("eoa");
  });

  it("changes the derived address when the master seed changes", () => {
    const before = deriveWallet("prin_a").address;
    process.env.MERIT_WALLET_SEED = "a-different-seed-value";
    expect(deriveWallet("prin_a").address).not.toBe(before);
  });

  it("circleDcwConfigured reflects the env", () => {
    expect(circleDcwConfigured()).toBe(false);
    process.env.CIRCLE_API_KEY = "x";
    process.env.CIRCLE_ENTITY_SECRET = "y";
    expect(circleDcwConfigured()).toBe(true);
  });

  it("provisionWallet returns the derived EOA by default", async () => {
    const w = await provisionWallet("prin_a");
    expect(w.address).toBe(deriveWallet("prin_a").address);
    expect(w.mode).toBe("eoa");
  });

  it("provisionWallet FAILS CLOSED in circle-dcw mode without config", async () => {
    process.env.MERIT_WALLET = "circle-dcw";
    await expect(provisionWallet("prin_a")).rejects.toThrow(/not set/);
  });
});

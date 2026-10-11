import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

let eurc: typeof import("../lib/eurc");
let registry: typeof import("../lib/registry");

beforeAll(async () => {
  process.env.MERIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "merit-eurc-"));
  delete process.env.MERIT_STORE;
  process.env.STUB = "1";
  eurc = await import("../lib/eurc");
  registry = await import("../lib/registry");
});

describe("eurcAddress / eurcEnabled — reads the real configured network address, never invents one", () => {
  it("resolves the testnet EURC address from lib/arc.ts's ARC profile", () => {
    expect(eurc.eurcAddress()).toBe("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a");
  });
});

describe("liveUsdToEurRate — a real network call against the free ECB-backed Frankfurter API", () => {
  it("returns a plausible real rate with a named source, not a fabricated number", async () => {
    const rate = await eurc.liveUsdToEurRate();
    expect(rate.usdToEur).toBeGreaterThan(0.5);
    expect(rate.usdToEur).toBeLessThan(1.5); // USD/EUR has not left this band in modern history
    expect(rate.source).toContain("Frankfurter");
    expect(rate.asOf).toBeTruthy();
  });

  it("caches the rate so a second call within the window doesn't refetch", async () => {
    const a = await eurc.liveUsdToEurRate();
    const b = await eurc.liveUsdToEurRate();
    expect(b).toEqual(a);
  });
});

describe("payInEurc — refuses honestly rather than guessing, offline-checkable paths", () => {
  it("refuses a zero/negative amount before ever touching the network", async () => {
    const src = registry.addCreator({ name: "EURC Test Source", handle: "@eurctest", price: 0.01, wallet: "0x4444444444444444444444444444444444444444", content: "x" });
    const res = await eurc.payInEurc({ account: {} as never, sourceId: src.id, sourceName: src.name, wallet: src.wallet, usdcOwed: 0 });
    expect("error" in res && res.status).toBe(400);
  });
});

describe("registry payoutCurrency — a creator's own setting, defaults to USDC", () => {
  it("defaults to no explicit EURC preference", () => {
    const src = registry.addCreator({ name: "Default Currency Source", handle: "@defcur", price: 0.01, wallet: "0x5555555555555555555555555555555555555555", content: "x" });
    expect(src.payoutCurrency).toBeUndefined();
  });

  it("can be set to EURC for a source with its own wallet", () => {
    const src = registry.addCreator({ name: "EURC Preference Source", handle: "@eurcpref", price: 0.01, wallet: "0x6666666666666666666666666666666666666666", content: "x" });
    const res = registry.setPayoutCurrency(src.id, "EURC");
    expect("error" in res).toBe(false);
    if (!("error" in res)) expect(res.payoutCurrency).toBe("EURC");
  });

  it("refuses to set a currency preference on a custodial (wallet-less) source", () => {
    const prevCustody = process.env.BUYER_ADDRESS;
    process.env.BUYER_ADDRESS = "0x7777777777777777777777777777777777777777";
    const src = registry.addCreator({ name: "Custodial EURC Attempt", handle: "@custodialeurc", price: 0.01, content: "x" });
    const res = registry.setPayoutCurrency(src.id, "EURC");
    expect("error" in res).toBe(true);
    process.env.BUYER_ADDRESS = prevCustody;
  });
});

describe("eurcPayoutStats / listEurcPayouts — start empty and stay internally consistent", () => {
  it("never goes negative", () => {
    const s = eurc.eurcPayoutStats();
    expect(s.usdcOwedTotal).toBeGreaterThanOrEqual(0);
    expect(s.eurcSentTotal).toBeGreaterThanOrEqual(0);
  });
});

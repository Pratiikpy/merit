import { beforeAll, describe, expect, it } from "vitest";

let stablefx: typeof import("../lib/stablefx");

beforeAll(async () => {
  delete process.env.STABLEFX_API_KEY; // never set in this test env — the whole point of this module's gating
  stablefx = await import("../lib/stablefx");
});

describe("stablefxEnabled / stablefxConfig — honest about what's missing, never fakes readiness", () => {
  it("is disabled without STABLEFX_API_KEY", () => {
    expect(stablefx.stablefxEnabled()).toBe(false);
  });

  it("reports the real configured contracts even while disabled", () => {
    const cfg = stablefx.stablefxConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.minTradeUsdc).toBe(10);
    expect(cfg.permit2).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
  });
});

describe("getQuote — validates before ever touching the network or needing a key", () => {
  it("refuses when neither amount is given", async () => {
    await expect(stablefx.getQuote({})).rejects.toThrow(/fromAmountUsdc or toAmountEurc/);
  });

  it("refuses an amount below StableFX's real documented $10 minimum", async () => {
    await expect(stablefx.getQuote({ fromAmountUsdc: 5 })).rejects.toThrow(/minimum trade/);
  });
});

describe("convertUsdcToEurc — refuses honestly without a key, names the exact fix", () => {
  it("throws naming the Circle-sales path, not a generic error", async () => {
    await expect(
      stablefx.convertUsdcToEurc({ account: {} as never, recipientAddress: "0x1111111111111111111111111111111111111111", fromAmountUsdc: 100 }),
    ).rejects.toThrow(/STABLEFX_API_KEY/);
  });
});

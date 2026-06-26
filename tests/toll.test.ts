import { describe, it, expect } from "vitest";
import { isAgentUA, tollQuote, decideToll } from "../lib/toll";
import { ARC } from "../lib/arc";
import type { Source } from "../lib/registry";

const SRC = {
  id: "src1",
  name: "StableData API",
  merit: 90,
  price: 0.01,
  priceMode: "fixed",
  wallet: ("0x" + "a".repeat(40)) as `0x${string}`,
  content: "stablecoin cross-border settlement reached $4.1T",
} as unknown as Source;

const HUMAN_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36";

describe("citation-toll x402 shim (W3)", () => {
  it("detects AI-agent crawlers and not human browsers", () => {
    expect(isAgentUA("GPTBot/1.0")).toBe(true);
    expect(isAgentUA("Mozilla/5.0 ClaudeBot")).toBe(true);
    expect(isAgentUA("PerplexityBot")).toBe(true);
    expect(isAgentUA("CCBot/2.0")).toBe(true);
    expect(isAgentUA(HUMAN_UA)).toBe(false);
    expect(isAgentUA("")).toBe(false);
  });

  it("builds an x402 quote priced to the source author's wallet on Arc", () => {
    const q = tollQuote(SRC, "the $4.1T claim");
    expect(q.x402Version).toBe(1);
    const a = q.accepts[0];
    expect(a.scheme).toBe("exact");
    expect(a.network).toBe(ARC.network);
    expect(a.asset).toBe(ARC.usdc);
    expect(a.payTo).toBe(SRC.wallet); // settles to the author, not Merit
    expect(a.maxAmountRequired).toBe("10000"); // 0.01 USDC × 1e6
    expect(a.resource).toBe("merit:citation:src1");
    expect(a.extra?.claim).toBe("the $4.1T claim");
    expect(q.source.priceUsdc).toBeCloseTo(0.01, 6);
  });

  it("decideToll: a payment proof passes; an agent without payment gets 402; a human reads free", () => {
    expect(decideToll({ ua: "GPTBot", payment: "0xpaid" }, SRC)).toEqual({ status: 200, settle: true });
    const gated = decideToll({ ua: "GPTBot", payment: null }, SRC);
    expect(gated.status).toBe(402);
    expect(gated.status === 402 && gated.quote.accepts[0].payTo).toBe(SRC.wallet);
    expect(decideToll({ ua: HUMAN_UA, payment: null }, SRC)).toEqual({ status: 200, settle: false });
  });

  it("tollAll mode tolls even a human browser (demo)", () => {
    expect(decideToll({ ua: HUMAN_UA, payment: null, tollAll: true }, SRC).status).toBe(402);
  });
});

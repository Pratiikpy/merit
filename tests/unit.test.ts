import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { round6, explorerTx, explorerAddr, llmConfig, isStub, hasLLM } from "../lib/arc";
import { cosine, parseSegments, citedNames } from "../lib/llm";
import { publicView, type Source } from "../lib/registry";
import { decodeFeedbackScore } from "../lib/reputation";

// ---- arc helpers ----
describe("arc helpers", () => {
  it("round6 rounds to 6-decimal USDC precision", () => {
    expect(round6(0.1234567)).toBe(0.123457);
    expect(round6(0.009 * 3)).toBe(0.027);
    expect(round6(0.067)).toBe(0.067);
  });
  it("explorer URLs point at arcscan", () => {
    expect(explorerTx("0xabc")).toBe("https://testnet.arcscan.app/tx/0xabc");
    expect(explorerAddr("0xdef")).toBe("https://testnet.arcscan.app/address/0xdef");
  });
});

// ---- env-driven config (isolate process.env per test) ----
const ENV_KEYS = [
  "LLM_API_KEY", "NVIDIA_API_KEY", "OPENAI_API_KEY", "LLM_BASE_URL",
  "LLM_MODEL", "EMBED_MODEL", "EMBED_INPUT_TYPE", "STUB", "BUYER_PRIVATE_KEY",
];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("llmConfig provider detection", () => {
  it("detects NVIDIA from an nvapi- key", () => {
    process.env.LLM_API_KEY = "nvapi-abc12345";
    const c = llmConfig();
    expect(c.isNvidia).toBe(true);
    expect(c.baseUrl).toContain("integrate.api.nvidia.com");
    expect(c.model).toContain("kimi");
    expect(c.embedModel).toContain("nv-embedqa");
    expect(c.usable).toBe(true);
  });
  it("detects OpenAI from an sk- key", () => {
    process.env.LLM_API_KEY = "sk-abc12345";
    const c = llmConfig();
    expect(c.isNvidia).toBe(false);
    expect(c.baseUrl).toContain("api.openai.com");
    expect(c.usable).toBe(true);
  });
  it("is not usable for a placeholder/empty key", () => {
    process.env.LLM_API_KEY = "your-openai-api-key";
    expect(llmConfig().usable).toBe(false);
    expect(hasLLM()).toBe(false);
  });
});

describe("isStub", () => {
  it("is true when STUB=1 even with a buyer key", () => {
    process.env.STUB = "1";
    process.env.BUYER_PRIVATE_KEY = "0xabc";
    expect(isStub()).toBe(true);
  });
  it("is true when no buyer key is configured", () => {
    expect(isStub()).toBe(true);
  });
  it("is false when STUB=0 and a buyer key is set", () => {
    process.env.STUB = "0";
    process.env.BUYER_PRIVATE_KEY = "0xabc";
    expect(isStub()).toBe(false);
  });
});

// ---- citation math + parsing ----
describe("cosine similarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  it("is 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
  it("is 0 for empty/degenerate input", () => {
    expect(cosine([], [])).toBe(0);
  });
});

describe("parseSegments + citedNames", () => {
  it("splits prose and [[citations]] into ordered segments", () => {
    expect(parseSegments("Intro [[Source A]] middle [[Source B]].")).toEqual([
      { t: "Intro " }, { c: "Source A" }, { t: " middle " }, { c: "Source B" }, { t: "." },
    ]);
  });
  it("returns a single text segment when there are no citations", () => {
    expect(parseSegments("no citations here")).toEqual([{ t: "no citations here" }]);
  });
  it("citedNames extracts the unique set of cited names", () => {
    expect([...citedNames("a [[X]] b [[Y]] c [[X]]")].sort()).toEqual(["X", "Y"]);
  });
});

// ---- security: the public view must never leak secrets ----
describe("publicView", () => {
  it("never exposes privateKey or raw content", () => {
    // Source no longer carries a private key, but inject a stray one anyway to prove the public
    // view strips ANY unexpected secret (defense-in-depth: deny-by-whitelist, not by field name).
    const s = {
      id: "x", name: "N", handle: "@n", kind: "K", initials: "NN", avatarBg: "#000",
      merit: 50, price: 0.01, wallet: "0xWALLET" as `0x${string}`, privateKey: "0xSECRETKEY",
      content: "secret source content", verified: true, balance: 12.3,
    } as Source & { privateKey: string };
    const v = publicView(s);
    const json = JSON.stringify(v);
    expect(v).not.toHaveProperty("privateKey");
    expect(v).not.toHaveProperty("content");
    expect(json).not.toContain("0xSECRETKEY");
    expect(json).not.toContain("secret source content");
    expect(v.wallet).toBe("0xWALLET");
    expect(v.balance).toBe(12.3);
  });
});

// ---- on-chain reputation: the subtle int128 score decode (2nd log word, sign-extended) ----
describe("decodeFeedbackScore", () => {
  // word1 = zeros, word2 = the int128 score sign-extended to 256 bits (how the ABI encodes it).
  const mkData = (score: number) =>
    "0x" + "0".repeat(64) + BigInt.asUintN(256, BigInt(score)).toString(16).padStart(64, "0");
  it("decodes a positive release score", () => {
    expect(decodeFeedbackScore(mkData(100))).toBe(100);
    expect(decodeFeedbackScore(mkData(3))).toBe(3);
  });
  it("decodes a negative refuse score (two's-complement, sign-extended)", () => {
    expect(decodeFeedbackScore(mkData(-40))).toBe(-40);
    expect(decodeFeedbackScore(mkData(-100))).toBe(-100);
  });
  it("decodes zero", () => {
    expect(decodeFeedbackScore(mkData(0))).toBe(0);
  });
});

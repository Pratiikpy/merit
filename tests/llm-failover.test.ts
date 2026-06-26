import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { llmProviders } from "../lib/arc";
import { _resetBreakers, _resetVerdictCache } from "../lib/llm";

const KEYS = [
  "LLM_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "EMBED_MODEL",
  "EMBED_INPUT_TYPE",
  "LLM_FALLBACK_API_KEY",
  "LLM_FALLBACK_BASE_URL",
  "LLM_FALLBACK_MODEL",
  "LLM_FALLBACK_EMBED_MODEL",
];

// The provider chain is what lets chat() fail over off a throttled key instead of collapsing to the offline
// fallback. Verified deterministically by driving it from env (no network).
describe("llmProviders (multi-provider failover chain)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is empty when no usable key is configured", () => {
    expect(llmProviders()).toEqual([]);
  });

  it("puts the primary first, then a distinct named fallback", () => {
    process.env.NVIDIA_API_KEY = "nvapi-" + "x".repeat(24);
    process.env.OPENAI_API_KEY = "sk-" + "y".repeat(40);
    const ps = llmProviders();
    expect(ps).toHaveLength(2);
    expect(ps[0].isNvidia).toBe(true); // primary resolves to NVIDIA (no LLM_API_KEY; NVIDIA before OPENAI)
    expect(ps[1].isNvidia).toBe(false); // the OpenAI key becomes the fallback
  });

  it("dedupes a key that is both primary and a named fallback", () => {
    process.env.OPENAI_API_KEY = "sk-" + "y".repeat(40); // primary picks it; the named-key add is deduped
    expect(llmProviders()).toHaveLength(1);
  });

  it("adds an explicit generic LLM_FALLBACK_* provider after the primary", () => {
    process.env.LLM_API_KEY = "sk-prim" + "a".repeat(30);
    process.env.LLM_FALLBACK_API_KEY = "sk-fb" + "b".repeat(30);
    process.env.LLM_FALLBACK_BASE_URL = "https://fallback.example/v1";
    process.env.LLM_FALLBACK_MODEL = "fallback-model";
    const ps = llmProviders();
    expect(ps).toHaveLength(2);
    expect(ps[1].baseUrl).toBe("https://fallback.example/v1");
    expect(ps[1].model).toBe("fallback-model");
  });

  it("drops an unusable (placeholder/too-short) key", () => {
    process.env.LLM_API_KEY = "your-key";
    expect(llmProviders()).toEqual([]);
  });
});

describe("llm test seams", () => {
  it("expose breaker + verdict-cache resets (callable without throwing)", () => {
    expect(() => {
      _resetBreakers();
      _resetVerdictCache();
    }).not.toThrow();
  });
});

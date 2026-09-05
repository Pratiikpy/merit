import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * Regression: the "judge unavailable" 503 used to be one hardcoded string that told the operator to
 * "configure an LLM key" no matter why the judge failed. On production it fired while a key WAS
 * configured and the provider was returning HTTP 402 (out of credit) — sending the operator to fix
 * configuration when the real problem was billing.
 *
 * The message must now name the true cause and the right party.
 */

const ORIGINAL_ENV = { ...process.env };

async function freshEngine() {
  vi.resetModules();
  return await import("../lib/verify/engine");
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("judgeUnavailableMessage", () => {
  it("says the demo is keyless only when there is genuinely no key", async () => {
    delete process.env.LLM_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const { judgeUnavailableMessage } = await freshEngine();
    const msg = judgeUnavailableMessage();
    expect(msg).toMatch(/keyless demo/i);
    expect(msg).toMatch(/set MERIT_NLI_URL or an LLM key/i);
  });

  it("blames billing, not configuration, when the provider returns 402", async () => {
    process.env.LLM_API_KEY = "sk-test-key-for-unit-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no credit", { status: 402 })),
    );
    vi.resetModules();
    const llm = await import("../lib/llm");
    const { judgeUnavailableMessage } = await import("../lib/verify/engine");

    // Drive a real judge call so the upstream 402 is observed and remembered.
    const verdict = await llm.judgeCitation("a claim", "a source passage");
    expect(verdict, "a 402 must leave the judge with no answer").toBeNull();

    const msg = judgeUnavailableMessage();
    expect(msg).toMatch(/402/);
    expect(msg).toMatch(/out of credit/i);
    // The exact regression: it must NOT tell the operator to configure a key they already set.
    expect(msg).not.toMatch(/keyless demo/i);
    expect(msg).toMatch(/a key is configured/i);
  });

  it("names a rejected key when the provider returns 401", async () => {
    process.env.LLM_API_KEY = "sk-bad-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    vi.resetModules();
    const llm = await import("../lib/llm");
    const { judgeUnavailableMessage } = await import("../lib/verify/engine");

    await llm.judgeCitation("a claim", "a source passage");
    const msg = judgeUnavailableMessage();
    expect(msg).toMatch(/401/);
    expect(msg).toMatch(/rejected the configured (LLM )?key/i);
    expect(msg).not.toMatch(/keyless demo/i);
  });

  it("owns a rate limit as our problem, not the user's input", async () => {
    process.env.LLM_API_KEY = "sk-test-key-for-unit-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("slow down", { status: 429 })),
    );
    vi.resetModules();
    const llm = await import("../lib/llm");
    const { judgeUnavailableMessage } = await import("../lib/verify/engine");

    await llm.judgeCitation("a claim", "a source passage");
    const msg = judgeUnavailableMessage();
    expect(msg).toMatch(/429/);
    expect(msg).toMatch(/on our side/i);
    // Never blame the caller's claim for our outage.
    expect(msg).not.toMatch(/different (prompt|claim)/i);
  });

  it("always tells the caller the deterministic numeric gate still applies", async () => {
    delete process.env.LLM_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const { judgeUnavailableMessage } = await freshEngine();
    expect(judgeUnavailableMessage()).toMatch(/numeric fabrications are still refused/i);
  });
});

describe("providerFailureMessage", () => {
  it("explains a 402 in human terms and never leaks the raw status alone", async () => {
    const { providerFailureMessage } = await import("../lib/llm");
    const m = providerFailureMessage(402, "Verified Inference");
    expect(m).toMatch(/out of credit/i);
    expect(m).toMatch(/on our side/i);
    expect(m).toMatch(/no charge/i);
    // The old text was `model "deepseek-v4-flash" unavailable (402)` — a raw status and model id.
    expect(m).not.toMatch(/^model "/);
  });

  it("owns a rate limit and invites a retry", async () => {
    const { providerFailureMessage } = await import("../lib/llm");
    const m = providerFailureMessage(429, "Verified Inference");
    expect(m).toMatch(/busy/i);
    expect(m).toMatch(/try again/i);
  });

  it("never blames the caller for an upstream failure", async () => {
    const { providerFailureMessage } = await import("../lib/llm");
    for (const s of [401, 402, 429, 500]) {
      expect(providerFailureMessage(s, "Verified Inference")).not.toMatch(/your (input|prompt|request)/i);
    }
  });
});

import { describe, it, expect } from "vitest";
import { MODELS, CHAT_MODELS, VISION_MODELS, DEFAULT_MODEL, getModel, isChatModel, blendedPrice, rankByQualityPerDollar } from "../lib/models";

describe("0G model registry", () => {
  it("carries the real live 0G chat ids and excludes the deprecated one", () => {
    const ids = MODELS.map((m) => m.id);
    for (const id of ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5", "glm-5.1", "glm-5.2", "qwen3.6-plus", "qwen3.7-plus", "qwen3.7-max", "kimi-k2.7-code", "minimax-m3", "0gm-1.0-35b-a3b", "claude-fable-5"]) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain("deepseek-v3"); // deprecated Jul 5 2026
  });

  it("expands the resale roster well beyond the original 6 chat models", () => {
    expect(CHAT_MODELS.length).toBeGreaterThanOrEqual(12);
    expect(CHAT_MODELS).toContain(DEFAULT_MODEL);
  });

  it("keeps non-text modalities out of the chat roster but in the catalog", () => {
    expect(CHAT_MODELS).not.toContain("whisper-large-v3");
    expect(CHAT_MODELS).not.toContain("z-image-turbo");
    expect(getModel("whisper-large-v3")?.modality).toBe("speech");
    expect(getModel("z-image-turbo")?.modality).toBe("image");
  });

  it("exposes both trust modes and both API surfaces", () => {
    expect(MODELS.some((m) => m.trust === "verified")).toBe(true);
    expect(MODELS.some((m) => m.trust === "private")).toBe(true);
    expect(getModel("claude-fable-5")?.api).toBe("anthropic");
    expect(getModel("deepseek-v4-flash")?.api).toBe("openai");
  });

  it("marks vision-capable models", () => {
    expect(VISION_MODELS).toContain("qwen3-vl-30b");
    expect(isChatModel("qwen3-vl-30b")).toBe(true); // vision model also serves text
  });
});

describe("verified-quality-per-dollar router", () => {
  it("does not just pick the cheapest — a proven model beats a cheap unproven one", () => {
    // give a mid-priced model a perfect real track record, leave a cheap one with a bad one
    const rates = {
      "glm-5.2": { verified: 40, total: 40 }, // proven right
      "deepseek-v4-flash": { verified: 1, total: 40 }, // cheap but almost always refused
    };
    const ranked = rankByQualityPerDollar(rates);
    const proven = ranked.findIndex((r) => r.id === "glm-5.2");
    const cheapBad = ranked.findIndex((r) => r.id === "deepseek-v4-flash");
    expect(proven).toBeLessThan(cheapBad); // proven ranks ahead despite higher price
  });

  it("with no history, cheaper models rank higher (prior is neutral)", () => {
    const ranked = rankByQualityPerDollar({});
    const flash = ranked.findIndex((r) => r.id === "deepseek-v4-flash");
    const pro = ranked.findIndex((r) => r.id === "deepseek-v4-pro");
    expect(flash).toBeLessThan(pro); // same neutral rate → cheaper wins
    expect(ranked[0].samples).toBe(0);
  });

  it("respects trust-mode, vision, and price filters", () => {
    const verifiedOnly = rankByQualityPerDollar({}, { trust: "verified" });
    expect(verifiedOnly.every((r) => getModel(r.id)?.trust === "verified")).toBe(true);
    expect(verifiedOnly.some((r) => r.id === "0gm-1.0-35b-a3b")).toBe(false); // 0GM is private

    const visionOnly = rankByQualityPerDollar({}, { needVision: true });
    expect(visionOnly.every((r) => getModel(r.id)?.vision)).toBe(true);

    const cheap = rankByQualityPerDollar({}, { maxInUsdPerM: 0.3 });
    expect(cheap.every((r) => getModel(r.id)!.inUsdPerM <= 0.3)).toBe(true);
    expect(cheap.some((r) => r.id === "claude-fable-5")).toBe(false); // $10/M input, filtered out
  });

  it("blended price weights output heavier than input", () => {
    const m = getModel("deepseek-v4-flash")!;
    expect(blendedPrice(m)).toBeCloseTo(m.inUsdPerM * 0.3 + m.outUsdPerM * 0.7, 6);
  });
});

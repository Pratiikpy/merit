/**
 * The 0G model roster Merit resells, with the metadata the verified-quality-per-dollar router needs.
 *
 * IDs are the real 0G router ids (from `GET {LLM_BASE_URL}/models`). Prices are 0G's discounted per-1M-token
 * USD rates; `vsOfficial` is the fraction cheaper than the model's own official API — a real cost signal the
 * router uses. 0G serves each model in one of two trust modes: fully **Verified** (TeeML + TeeTLS, the response
 * carries a retrievable hardware attestation) or **Private** (TeeML only). Merit exposes both and labels which.
 *
 * The router does NOT pick the cheapest model — it picks the best *verified-quality-per-dollar*: a model's
 * smoothed verified-pass rate (from real inference receipts) divided by its blended price. Cheap-but-wrong loses
 * to slightly-pricier-but-right, because a refused answer costs the buyer $0 and wastes a round-trip.
 *
 * `deepseek-v3` is intentionally omitted (0G deprecated it Jul 5 2026). `z-image-turbo` (image gen) is in the
 * roster for completeness but is NOT wired into the paid verified router — its "verified" demand is C2PA
 * provenance, a different layer than attested inference (see the PMF plan), so it waits for a demand signal.
 */
export type TrustMode = "verified" | "private";
export type Modality = "chat" | "vision" | "speech" | "image";

export interface ModelInfo {
  id: string;
  label: string;
  series: string;
  trust: TrustMode; // 0G's default serving mode for this model
  api: "openai" | "anthropic";
  modality: Modality;
  tools: boolean;
  vision: boolean;
  ctx: string; // human-readable context window
  inUsdPerM: number; // input price, USD per 1M tokens (0G discounted rate)
  outUsdPerM: number; // output price, USD per 1M tokens
  vsOfficial: number; // fraction cheaper than the official API (0.12 = 12% off); 0 if in-house/unknown
}

// The live 0G roster (real router ids + catalog metadata). Ordered cheap→premium within chat.
export const MODELS: ModelInfo[] = [
  { id: "deepseek-v4-flash", label: "DeepSeek-V4-Flash", series: "DeepSeek", trust: "verified", api: "openai", modality: "chat", tools: true, vision: false, ctx: "1M", inUsdPerM: 0.1214, outUsdPerM: 0.242, vsOfficial: 0.12 },
  { id: "qwen3.6-plus", label: "Qwen3.6-Plus", series: "Qwen", trust: "verified", api: "openai", modality: "chat", tools: true, vision: false, ctx: "1M", inUsdPerM: 0.2428, outUsdPerM: 1.4528, vsOfficial: 0.5 },
  { id: "qwen3.7-plus", label: "Qwen3.7-Plus", series: "Qwen", trust: "verified", api: "openai", modality: "chat", tools: true, vision: true, ctx: "1M", inUsdPerM: 0.2208, outUsdPerM: 0.8808, vsOfficial: 0.45 },
  { id: "glm-5", label: "GLM-5", series: "GLM", trust: "verified", api: "openai", modality: "chat", tools: true, vision: false, ctx: "203K", inUsdPerM: 0.5042, outUsdPerM: 2.2704, vsOfficial: 0.4 },
  { id: "minimax-m3", label: "MiniMax-M3", series: "MiniMax", trust: "verified", api: "openai", modality: "chat", tools: true, vision: true, ctx: "1M", inUsdPerM: 0.6, outUsdPerM: 2.4, vsOfficial: 0.55 },
  { id: "kimi-k2.7-code", label: "Kimi-K2.7-Code", series: "Kimi", trust: "verified", api: "openai", modality: "chat", tools: true, vision: true, ctx: "262K", inUsdPerM: 0.7866, outUsdPerM: 3.2675, vsOfficial: 0.18 },
  { id: "qwen3.7-max", label: "Qwen3.7-Max", series: "Qwen", trust: "verified", api: "openai", modality: "chat", tools: true, vision: false, ctx: "1M", inUsdPerM: 0.825, outUsdPerM: 2.4754, vsOfficial: 0.6 },
  { id: "glm-5.1", label: "GLM-5.1", series: "GLM", trust: "private", api: "openai", modality: "chat", tools: true, vision: false, ctx: "207K", inUsdPerM: 0.86, outUsdPerM: 2.71, vsOfficial: 0.35 },
  { id: "glm-5.2", label: "GLM-5.2", series: "GLM", trust: "verified", api: "openai", modality: "chat", tools: true, vision: false, ctx: "1M", inUsdPerM: 0.968, outUsdPerM: 3.3888, vsOfficial: 0.3 },
  { id: "deepseek-v4-pro", label: "DeepSeek-V4-Pro", series: "DeepSeek", trust: "verified", api: "openai", modality: "chat", tools: true, vision: false, ctx: "1M", inUsdPerM: 1.452, outUsdPerM: 2.9048, vsOfficial: 0.15 },
  { id: "0gm-1.0-35b-a3b", label: "0GM-1.0-35B-A3B", series: "0GM", trust: "private", api: "openai", modality: "chat", tools: true, vision: true, ctx: "262K", inUsdPerM: 0.16, outUsdPerM: 0.96, vsOfficial: 0.8 },
  { id: "claude-fable-5", label: "Claude Fable 5", series: "Claude", trust: "verified", api: "anthropic", modality: "chat", tools: true, vision: true, ctx: "1M", inUsdPerM: 10, outUsdPerM: 50, vsOfficial: 0.1 },
  { id: "qwen3-vl-30b", label: "Qwen3-VL-30B", series: "Qwen", trust: "verified", api: "openai", modality: "vision", tools: true, vision: true, ctx: "262K", inUsdPerM: 0.0193, outUsdPerM: 0.1892, vsOfficial: 0 },
  { id: "whisper-large-v3", label: "Whisper Large v3", series: "Whisper", trust: "verified", api: "openai", modality: "speech", tools: false, vision: false, ctx: "-", inUsdPerM: 0, outUsdPerM: 0, vsOfficial: 0 },
  { id: "z-image-turbo", label: "Z-Image-Turbo", series: "Z-Image", trust: "verified", api: "openai", modality: "image", tools: false, vision: false, ctx: "2K", inUsdPerM: 0, outUsdPerM: 0, vsOfficial: 0 },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));
export function getModel(id: string): ModelInfo | undefined {
  return BY_ID.get(id);
}

// Text models the verified inference tiers can use (chat + the vision model, which also serves text).
export const CHAT_MODELS: string[] = MODELS.filter((m) => m.modality === "chat" || m.modality === "vision").map((m) => m.id);
export const VISION_MODELS: string[] = MODELS.filter((m) => m.vision).map((m) => m.id);
export const DEFAULT_MODEL = "deepseek-v4-flash";
export const DEFAULT_VISION_MODEL = "qwen3-vl-30b";
export const DEFAULT_SPEECH_MODEL = "whisper-large-v3";

export function isChatModel(id: string): boolean {
  return CHAT_MODELS.includes(id);
}

/** Blended price signal, USD per 1M tokens. Answers are output-heavy, so weight output. */
export function blendedPrice(m: ModelInfo): number {
  return m.inUsdPerM * 0.3 + m.outUsdPerM * 0.7;
}

export interface RouteOpts {
  trust?: TrustMode; // require a trust mode (e.g. only fully-Verified TeeML+TeeTLS)
  needVision?: boolean; // require a vision-capable model
  needTools?: boolean; // require tool-calling
  maxInUsdPerM?: number; // hard price ceiling on input
  exclude?: string[]; // model ids to skip
}

export interface RankedModel {
  id: string;
  label: string;
  score: number; // verified-quality-per-dollar (higher = better)
  verifiedRate: number; // smoothed pass rate used
  samples: number; // real receipts backing the rate
  blendedUsdPerM: number;
  trust: TrustMode;
}

/**
 * Rank the chat roster by verified-quality-per-dollar. `verifiedRateById` maps model id → {verified,total} from
 * real inference receipts; models with little history are smoothed toward a neutral prior so a brand-new model
 * is neither unfairly trusted nor buried. score = smoothedRate / blendedPrice.
 */
export function rankByQualityPerDollar(
  verifiedRateById: Record<string, { verified: number; total: number }>,
  opts: RouteOpts = {},
): RankedModel[] {
  const PRIOR_PASSES = 3; // Bayesian smoothing: pretend ~3 of 5 prior trials passed (~0.6)
  const PRIOR_TRIALS = 5;
  const candidates = MODELS.filter((m) => {
    if (m.modality !== "chat" && m.modality !== "vision") return false;
    if (opts.trust && m.trust !== opts.trust) return false;
    if (opts.needVision && !m.vision) return false;
    if (opts.needTools && !m.tools) return false;
    if (opts.maxInUsdPerM != null && m.inUsdPerM > opts.maxInUsdPerM) return false;
    if (opts.exclude && opts.exclude.includes(m.id)) return false;
    return true;
  });
  return candidates
    .map((m) => {
      const s = verifiedRateById[m.id] || { verified: 0, total: 0 };
      const verifiedRate = (s.verified + PRIOR_PASSES) / (s.total + PRIOR_TRIALS);
      const price = blendedPrice(m) || 0.001;
      // quality-per-dollar with quality DOMINANT (rate²/price): a model that is usually refused must not win on
      // price alone — a cheap-but-wrong model wastes round-trips and leaves the buyer without an answer.
      return {
        id: m.id,
        label: m.label,
        score: (verifiedRate * verifiedRate) / price,
        verifiedRate,
        samples: s.total,
        blendedUsdPerM: Math.round(price * 10000) / 10000,
        trust: m.trust,
      };
    })
    .sort((a, b) => b.score - a.score);
}

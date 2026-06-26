/**
 * Arc testnet constants + environment helpers for Merit.
 * All addresses verified against docs.arc.io / Circle reference repos.
 */

export const ARC = {
  chainId: 5042002,
  network: "eip155:5042002",
  rpcUrl: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
  explorer: "https://testnet.arcscan.app",
  usdc: "0x3600000000000000000000000000000000000000",
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  // ERC-8004 registries (live on Arc testnet)
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const;

/** True when we should simulate the chain (no keys/funds needed). */
export function isStub(): boolean {
  if (process.env.STUB === "1") return true;
  // Auto-stub if the buyer wallet isn't configured — keeps the app runnable.
  if (!process.env.BUYER_PRIVATE_KEY) return true;
  return false;
}

export interface LlmProvider {
  key: string;
  baseUrl: string;
  model: string;
  embedModel: string;
  embedInputType: string;
  isNvidia: boolean;
  usable: boolean;
}

/** Build a provider config from a key + optional overrides, applying NVIDIA/OpenAI defaults. */
function buildProvider(
  key: string,
  baseUrl?: string,
  model?: string,
  embedModel?: string,
  embedInputType?: string,
): LlmProvider {
  const isNvidia = key.startsWith("nvapi-");
  return {
    key,
    baseUrl: baseUrl || (isNvidia ? "https://integrate.api.nvidia.com/v1" : "https://api.openai.com/v1"),
    model: model || (isNvidia ? "moonshotai/kimi-k2.6" : "gpt-4o-mini"),
    embedModel: embedModel || (isNvidia ? "nvidia/nv-embedqa-e5-v5" : "text-embedding-3-small"),
    embedInputType: embedInputType || (isNvidia ? "query" : ""),
    isNvidia,
    usable: !!key && !key.startsWith("your-") && key.length > 8,
  };
}

/** Provider-agnostic LLM config (NVIDIA, OpenAI, or any OpenAI-compatible API) — the PRIMARY provider. */
export function llmConfig(): LlmProvider {
  const key = process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY || process.env.OPENAI_API_KEY || "";
  return buildProvider(
    key,
    process.env.LLM_BASE_URL,
    process.env.LLM_MODEL,
    process.env.EMBED_MODEL,
    process.env.EMBED_INPUT_TYPE,
  );
}

/** The ordered LLM provider chain: the primary first, then any distinct fallbacks — an explicit
 *  `LLM_FALLBACK_*` provider, plus any separately-configured OpenAI/NVIDIA key. `chat()` fails over across
 *  this chain on a 429/5xx/timeout, so a single throttled key no longer collapses the proof-of-citation moat
 *  under load. Deduped by (baseUrl, model, key); only usable providers are returned. */
export function llmProviders(): LlmProvider[] {
  const out: LlmProvider[] = [];
  const seen = new Set<string>();
  const add = (p: LlmProvider) => {
    const sig = `${p.baseUrl}|${p.model}|${p.key}`;
    if (p.usable && !seen.has(sig)) {
      seen.add(sig);
      out.push(p);
    }
  };
  add(llmConfig()); // primary
  if (process.env.LLM_FALLBACK_API_KEY) {
    add(
      buildProvider(
        process.env.LLM_FALLBACK_API_KEY,
        process.env.LLM_FALLBACK_BASE_URL,
        process.env.LLM_FALLBACK_MODEL,
        process.env.LLM_FALLBACK_EMBED_MODEL,
      ),
    );
  }
  if (process.env.OPENAI_API_KEY) add(buildProvider(process.env.OPENAI_API_KEY));
  if (process.env.NVIDIA_API_KEY) add(buildProvider(process.env.NVIDIA_API_KEY));
  return out;
}

export function hasLLM(): boolean {
  return llmConfig().usable;
}

export function explorerTx(hash: string): string {
  return `${ARC.explorer}/tx/${hash}`;
}

export function explorerAddr(addr: string): string {
  return `${ARC.explorer}/address/${addr}`;
}

/** A plausible-looking fake tx hash for STUB mode. */
export function fakeTxHash(): string {
  const hex = "0123456789abcdef";
  let h = "0x";
  for (let i = 0; i < 64; i++) h += hex[Math.floor(Math.random() * 16)];
  return h;
}

/** Round to 6-decimal USDC precision (dollar number). */
export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

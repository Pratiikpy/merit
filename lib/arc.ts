/**
 * Arc network configuration — one profile, selected by `ARC_NETWORK`, that every chain-touching module reads.
 *
 * Merit was written against Arc Testnet and hard-coded it: chain id 5042002, the testnet RPC, the testnet
 * explorer, and viem's `arcTestnet` imported in nine modules. That is fine until the day the chain changes, and
 * then it is a rewrite. This module makes the network a configuration value instead.
 *
 * `ARC_NETWORK=testnet` (the default) reproduces the previous behaviour exactly — the same ids, addresses and
 * RPC that every verified transaction in this repo was produced against.
 *
 * `ARC_NETWORK=mainnet` reads its addresses from the environment and INVENTS NOTHING. Circle has not published
 * Arc mainnet contract addresses or RPC endpoints — the Arc docs say so plainly ("Mainnet addresses are not yet
 * available"), and Circle's own Gateway SDK ships `arcTestnet` with no mainnet counterpart. So the mainnet
 * profile is a set of required inputs, not a set of guesses: `mainnetReadiness()` reports exactly which values
 * are supplied and which are still missing, and the app says so rather than pretending. The moment Circle
 * publishes them, Merit runs on mainnet by setting environment variables — no code change.
 */
import { defineChain, type Chain } from "viem";
import { arcTestnet } from "viem/chains";

export type ArcNetworkName = "testnet" | "mainnet";

export interface ArcProfile {
  name: ArcNetworkName;
  label: string;
  chainId: number;
  network: string; // CAIP-2, eip155:<chainId> — what x402 payment requirements quote
  rpcUrl: string;
  explorer: string;
  usdc: string;
  gatewayWallet: string;
  identityRegistry: string;
  reputationRegistry: string;
  validationRegistry: string;
  multicall3: string;
  memo: string;
  multicall3From: string;
  systemTransferEmitter: string;
  /** The chain key Circle's Gateway/nanopayments SDK uses. Null on a network Circle has not shipped support
   *  for — Merit must not invent one, because a wrong key fails at settlement time, not at startup. */
  gatewayChainName: string | null;
  /** Faucet-funded, valueless test money. False on mainnet, where every guard is real. */
  isTestnet: boolean;
}

/** Arc Testnet — every address here was verified against the live chain with `eth_getCode` or a real call. */
const TESTNET: ArcProfile = {
  name: "testnet",
  label: "Arc Testnet",
  chainId: 5042002,
  network: "eip155:5042002",
  rpcUrl: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
  explorer: process.env.ARC_EXPLORER || "https://testnet.arcscan.app",
  usdc: "0x3600000000000000000000000000000000000000",
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  // ERC-8004 registries (live on Arc testnet)
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  // Arc transaction extensions — predeployed contracts that route subcalls through the CallFrom precompile, so
  // the ORIGINAL EOA stays `msg.sender` in each subcall (a USDC Transfer still reads `from = your wallet`, not
  // the wrapper). `memo` attaches application metadata to a call and emits it as an event; `multicall3From`
  // batches calls with the same sender preservation. Both verified deployed on Arc testnet (eth_getCode).
  memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
  multicall3From: "0x522fAf9A91c41c443c66765030741e4AaCe147D0",
  // Arc's native USDC system emitter (EIP-7708). It logs a Transfer for EVERY USDC movement at 18 decimals —
  // including the ones behind the 6-decimal ERC-20 interface, so a single ERC-20 transfer() emits BOTH. Match on
  // the emitter address or the same movement is counted twice, and never mix the two precisions.
  systemTransferEmitter: "0xfffffffffffffffffffffffffffffffffffffffe",
  gatewayChainName: "arcTestnet", // Gateway domain 26, per @circle-fin/x402-batching
  isTestnet: true,
};

/** The environment variables the mainnet profile is assembled from. */
export const MAINNET_ENV = {
  chainId: "ARC_MAINNET_CHAIN_ID",
  rpcUrl: "ARC_MAINNET_RPC_URL",
  explorer: "ARC_MAINNET_EXPLORER",
  usdc: "ARC_MAINNET_USDC",
  gatewayWallet: "ARC_MAINNET_GATEWAY_WALLET",
  identityRegistry: "ARC_MAINNET_IDENTITY_REGISTRY",
  reputationRegistry: "ARC_MAINNET_REPUTATION_REGISTRY",
  validationRegistry: "ARC_MAINNET_VALIDATION_REGISTRY",
  memo: "ARC_MAINNET_MEMO",
  multicall3From: "ARC_MAINNET_MULTICALL3FROM",
  gatewayChainName: "ARC_MAINNET_GATEWAY_CHAIN",
} as const;

/** Values that are identical on any EVM chain, or that Arc fixes at the protocol level rather than per
 *  deployment — so they need no mainnet-specific input. */
const CHAIN_INVARIANT = {
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11", // canonical CREATE2 deployment
  systemTransferEmitter: "0xfffffffffffffffffffffffffffffffffffffffe", // EIP-7708 system address
} as const;

function envVal(name: string): string {
  return (process.env[name] || "").trim();
}

function buildMainnet(): ArcProfile {
  const chainId = Number(envVal(MAINNET_ENV.chainId)) || 0;
  return {
    name: "mainnet",
    label: "Arc",
    chainId,
    network: chainId ? `eip155:${chainId}` : "",
    rpcUrl: envVal(MAINNET_ENV.rpcUrl),
    explorer: envVal(MAINNET_ENV.explorer),
    usdc: envVal(MAINNET_ENV.usdc),
    gatewayWallet: envVal(MAINNET_ENV.gatewayWallet),
    identityRegistry: envVal(MAINNET_ENV.identityRegistry),
    reputationRegistry: envVal(MAINNET_ENV.reputationRegistry),
    validationRegistry: envVal(MAINNET_ENV.validationRegistry),
    multicall3: CHAIN_INVARIANT.multicall3,
    memo: envVal(MAINNET_ENV.memo),
    multicall3From: envVal(MAINNET_ENV.multicall3From),
    systemTransferEmitter: CHAIN_INVARIANT.systemTransferEmitter,
    gatewayChainName: envVal(MAINNET_ENV.gatewayChainName) || null,
    isTestnet: false,
  };
}

/** Which network this process is configured for. An unrecognised value falls back to testnet rather than
 *  guessing — the safe direction, since testnet money is valueless and mainnet money is not. */
export function arcNetworkName(): ArcNetworkName {
  return (process.env.ARC_NETWORK || "").trim().toLowerCase() === "mainnet" ? "mainnet" : "testnet";
}

/**
 * The active Arc profile. Every chain-touching module reads this, so the whole app moves network together.
 * Shape-compatible with the constant it replaces, so existing `ARC.usdc` / `ARC.chainId` call sites are
 * unchanged.
 */
export const ARC: ArcProfile = arcNetworkName() === "mainnet" ? buildMainnet() : TESTNET;

export interface MainnetReadiness {
  network: ArcNetworkName;
  settlementReady: boolean;
  missing: Array<{ field: string; env: string; gates: string }>;
  configured: string[];
  note: string;
}

/**
 * What is still missing before this deployment could run on Arc mainnet. Honest by construction: it names the
 * env var to set for each unmet requirement, and never substitutes a testnet address for a mainnet one.
 *
 * `settlementReady` is the floor for moving money — a chain id, an RPC and the USDC address. The rest gate
 * individual features (ERC-8004 writes, memoed payouts, batched claims, Gateway nanopayments), each of which
 * already degrades honestly on its own when its address is absent.
 */
export function mainnetReadiness(): MainnetReadiness {
  const p = ARC;
  const GATES: Array<{ field: keyof ArcProfile; env: string; gates: string; core: boolean }> = [
    { field: "chainId", env: MAINNET_ENV.chainId, gates: "every on-chain read and write", core: true },
    { field: "rpcUrl", env: MAINNET_ENV.rpcUrl, gates: "every on-chain read and write", core: true },
    { field: "usdc", env: MAINNET_ENV.usdc, gates: "all USDC settlement", core: true },
    { field: "explorer", env: MAINNET_ENV.explorer, gates: "receipt links (cosmetic)", core: false },
    { field: "gatewayWallet", env: MAINNET_ENV.gatewayWallet, gates: "Circle Gateway nanopayments (x402 tolls)", core: false },
    { field: "identityRegistry", env: MAINNET_ENV.identityRegistry, gates: "ERC-8004 identity mints", core: false },
    { field: "reputationRegistry", env: MAINNET_ENV.reputationRegistry, gates: "ERC-8004 reputation writes", core: false },
    { field: "validationRegistry", env: MAINNET_ENV.validationRegistry, gates: "ERC-8004 validation writes", core: false },
    { field: "memo", env: MAINNET_ENV.memo, gates: "memoed payouts (falls back to a plain transfer)", core: false },
    { field: "multicall3From", env: MAINNET_ENV.multicall3From, gates: "batched claims (falls back to one tx per creator)", core: false },
    { field: "gatewayChainName", env: MAINNET_ENV.gatewayChainName, gates: "Circle Gateway chain selection", core: false },
  ];
  const missing = GATES.filter((g) => !p[g.field]).map((g) => ({ field: String(g.field), env: g.env, gates: g.gates }));
  const configured = GATES.filter((g) => !!p[g.field]).map((g) => String(g.field));
  const settlementReady = GATES.filter((g) => g.core).every((g) => !!p[g.field]);
  return {
    network: p.name,
    settlementReady,
    missing,
    configured,
    note:
      p.name === "testnet"
        ? "Running on Arc Testnet. Set ARC_NETWORK=mainnet plus the ARC_MAINNET_* values to move this deployment to Arc mainnet — no code change is required."
        : settlementReady
          ? "Configured for Arc mainnet. Any feature whose address is unset degrades honestly rather than falling back to a testnet address."
          : "ARC_NETWORK=mainnet is set but the core settlement values are not. Merit will not substitute testnet addresses; supply the environment variables listed in `missing`.",
  };
}

/**
 * The viem `Chain` for the active network. On testnet this is viem's own `arcTestnet`, so nothing about the
 * behaviour verified in this repo changes; on mainnet it is built from the configured values.
 */
let _chain: Chain | null = null;
export function arcChain(): Chain {
  if (_chain) return _chain;
  _chain =
    ARC.name === "testnet"
      ? arcTestnet
      : defineChain({
          id: ARC.chainId,
          name: ARC.label,
          nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
          rpcUrls: { default: { http: ARC.rpcUrl ? [ARC.rpcUrl] : [] } },
          ...(ARC.explorer ? { blockExplorers: { default: { name: "Arcscan", url: ARC.explorer } } } : {}),
        });
  return _chain;
}

/** Human label for the active network, for UI and API copy: "Arc Testnet 5042002". */
export function chainLabel(): string {
  return ARC.chainId ? `${ARC.label} ${ARC.chainId}` : `${ARC.label} (chain id not configured)`;
}

/** Test seam: drop the memoized viem chain so a test can flip networks. */
export function _resetArcChain(): void {
  _chain = null;
}

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

/** The EMBEDDING provider — its OWN key/base/model, so embeddings can stay on a provider that HAS an
 *  embeddings endpoint (e.g. NVIDIA) even when the chat/judge provider (e.g. 0G router) does not. Falls back
 *  to the primary LLM config when no EMBED_API_KEY is set, so existing single-provider setups are unchanged.
 *  Keeping this separate matters because embedRaw trips a circuit breaker on failure — without it, embed
 *  failures on a no-embeddings chat provider would take the JUDGE offline. */
export function embedConfig(): LlmProvider {
  const key = process.env.EMBED_API_KEY;
  if (!key) return llmConfig(); // no dedicated embed provider → use the primary (unchanged behavior)
  return buildProvider(key, process.env.EMBED_BASE_URL, undefined, process.env.EMBED_MODEL, process.env.EMBED_INPUT_TYPE);
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

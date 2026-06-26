/**
 * Settlement assets (W4) — USDC by default, EURC as a second settlement currency (the EU-creator lane), with
 * a CCTP crosschain-onramp seam so a creator/agent can fund from any chain. USDC is Arc's native token; EURC
 * + CCTP are gated drop-ins (enabled by env when the addresses are available), so the default build settles
 * USDC exactly as before. Pure helpers → unit-tested.
 */
import { ARC } from "./arc";

export type Asset = "USDC" | "EURC";

// EURC on Arc testnet (set when enabled); USDC is the native precompile in lib/arc.ts. Read lazily (not at
// module load) so the env reflects current configuration.
function eurcAddress(): string {
  return process.env.EURC_ADDRESS || "";
}

export interface AssetMeta {
  symbol: Asset;
  address: string;
  decimals: number;
  enabled: boolean;
}

export function assetMeta(asset: Asset): AssetMeta {
  if (asset === "EURC") {
    const addr = eurcAddress();
    return { symbol: "EURC", address: addr, decimals: 6, enabled: !!addr };
  }
  return { symbol: "USDC", address: ARC.usdc, decimals: 6, enabled: true };
}

/** The active settlement asset — USDC unless MERIT_ASSET=EURC AND EURC is configured (else falls back). */
export function settlementAsset(): Asset {
  const want = (process.env.MERIT_ASSET || "USDC").toUpperCase();
  return want === "EURC" && assetMeta("EURC").enabled ? "EURC" : "USDC";
}

/** Convert a dollar/euro amount to atomic units (both USDC and EURC use 6 decimals). */
export function toAtomic(amount: number, asset: Asset = "USDC"): bigint {
  const d = assetMeta(asset).decimals;
  return BigInt(Math.round(Math.max(0, amount) * 10 ** d));
}

/** Whether the CCTP crosschain onramp is configured (gated drop-in — needs the CCTP contracts/API). */
export function cctpConfigured(): boolean {
  return !!(process.env.CCTP_API || process.env.CCTP_TOKEN_MESSENGER);
}

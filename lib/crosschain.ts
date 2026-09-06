/**
 * Cross-chain payout (Hub feature #4) — withdraw VERIFIED earnings from Arc to any Circle Gateway chain.
 *
 * A creator or worker earned on Arc because their work verified; this lets them take those USDC to the chain
 * they actually use — Base, Arbitrum, Optimism, or Avalanche — in one Circle Gateway cross-chain transfer
 * (burn from the unified balance on Arc, mint on the destination). It broadens Merit's Circle stack (which was
 * DCW + x402-batching only) with Gateway's cross-chain settlement, and serves humans as much as agents: the
 * last mile of getting paid where you want it. Every payout is compliance-screened first and recorded.
 *
 * Honesty: a payout reflects a REAL Gateway transfer only — `hash` is the mint tx on the destination chain, and
 * the deployment fails CLOSED (a clear, honest error) when the buyer wallet / Gateway balance isn't funded,
 * never a fabricated transfer. Stub-safe. Holds the buyer key only to sign the transfer, like lib/pay.ts.
 */
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { getAddress } from "viem";
import { ARC, isStub, round6 } from "./arc";
import { assertPayeeCompliant } from "./compliance";
import { ensureDeposit } from "./pay";
import { loadDoc, saveDoc } from "./store";

/** The Gateway chains Merit can settle a cross-chain payout to, with a human label and the block explorer that
 *  shows the DESTINATION mint tx. The set follows Arc's network: a testnet Arc pays out to Circle's TESTNET
 *  Gateway domains, a mainnet Arc to the mainnet ones. Mixing the two is not a degraded experience but a failed
 *  transfer — Gateway will not burn on a testnet domain and mint on a mainnet one. Chain keys are Circle's own
 *  (`GATEWAY_DOMAINS` in @circle-fin/x402-batching). Arc itself is included so a same-chain payout also works. */
const TESTNET_PAYOUT_CHAINS: Record<string, { label: string; explorer: string }> = {
  baseSepolia: { label: "Base Sepolia", explorer: "https://sepolia.basescan.org/tx/" },
  arbitrumSepolia: { label: "Arbitrum Sepolia", explorer: "https://sepolia.arbiscan.io/tx/" },
  optimismSepolia: { label: "Optimism Sepolia", explorer: "https://sepolia-optimism.etherscan.io/tx/" },
  avalancheFuji: { label: "Avalanche Fuji", explorer: "https://testnet.snowtrace.io/tx/" },
};
const MAINNET_PAYOUT_CHAINS: Record<string, { label: string; explorer: string }> = {
  base: { label: "Base", explorer: "https://basescan.org/tx/" },
  arbitrum: { label: "Arbitrum One", explorer: "https://arbiscan.io/tx/" },
  optimism: { label: "Optimism", explorer: "https://optimistic.etherscan.io/tx/" },
  avalanche: { label: "Avalanche C-Chain", explorer: "https://snowtrace.io/tx/" },
};

export const PAYOUT_CHAINS: Record<string, { label: string; explorer: string }> = {
  ...(ARC.isTestnet ? TESTNET_PAYOUT_CHAINS : MAINNET_PAYOUT_CHAINS),
  // The Arc row follows the active network, so a same-chain payout links to the right explorer. Omitted when
  // Circle has published no Gateway chain key for this Arc network — an unnamed chain cannot be settled to.
  ...(ARC.gatewayChainName ? { [ARC.gatewayChainName]: { label: ARC.label, explorer: `${ARC.explorer}/tx/` } } : {}),
};

export function supportedPayoutChains(): Array<{ chain: string; label: string }> {
  return Object.entries(PAYOUT_CHAINS).map(([chain, v]) => ({ chain, label: v.label }));
}

let gateway: GatewayClient | null = null;
function client(): GatewayClient {
  if (gateway) return gateway;
  const chainName = ARC.gatewayChainName;
  if (!chainName) {
    // Circle's Gateway SDK ships no chain key for this network yet. Fail with the reason rather than guessing a
    // name, which would surface as an opaque settlement error much later.
    throw new Error(`Circle Gateway has no chain key configured for ${ARC.label} — set ${"ARC_MAINNET_GATEWAY_CHAIN"} once Circle publishes it`);
  }
  gateway = new GatewayClient({
    chain: chainName as "arcTestnet",
    privateKey: process.env.BUYER_PRIVATE_KEY as `0x${string}`,
    rpcUrl: process.env.ARC_RPC_URL,
  });
  return gateway;
}

export interface PayoutRecord {
  id: string;
  amount: number;
  chain: string;
  recipient: string;
  hash: string;
  explorerUrl: string;
  at: string;
}
interface PayoutLog {
  records: PayoutRecord[];
}
const DOC = "crosschain";

function recordPayout(r: PayoutRecord): void {
  try {
    const log = loadDoc<PayoutLog>(DOC, { records: [] });
    if (!log.records) log.records = [];
    log.records.push(r);
    if (log.records.length > 2000) log.records = log.records.slice(-2000);
    saveDoc(DOC, log);
  } catch (e) {
    console.error("[crosschain] record failed:", (e as Error).message);
  }
}

export function recentPayouts(n = 30): PayoutRecord[] {
  const log = loadDoc<PayoutLog>(DOC, { records: [] });
  return (log.records || []).slice(-n).reverse();
}

/** Read the Gateway unified balance (available to settle across chains). Null in stub / on error — an honest
 *  "unknown", never a fabricated number. */
export async function gatewayBalance(): Promise<{ available: number; withdrawable: number } | null> {
  if (isStub() || !process.env.BUYER_PRIVATE_KEY) return null;
  try {
    const b = await client().getBalances();
    return { available: round6(Number(b.gateway.available) / 1e6), withdrawable: round6(Number(b.gateway.withdrawable) / 1e6) };
  } catch (e) {
    console.error("[crosschain] balance read failed:", (e as Error).message);
    return null;
  }
}

export type PayoutResult =
  | { ok: true; hash: string; chain: string; label: string; amount: number; recipient: string; explorerUrl: string }
  | { ok: false; error: string; status: number };

/**
 * Settle a cross-chain payout: compliance-screen the recipient, then Gateway-transfer `amount` USDC to
 * `recipient` on `chain` (burn on Arc, mint on the destination). Returns the destination mint tx, or a typed,
 * honest error (unsupported chain, bad address, denied payee, unfunded/stub deployment, transfer failure).
 */
export async function crossChainPayout(input: { amount: number; chain: string; recipient: string }): Promise<PayoutResult> {
  const amount = round6(Number(input.amount) || 0);
  const chain = (input.chain || "").trim();
  if (!(amount > 0)) return { ok: false, error: "amount must be positive", status: 400 };
  if (!PAYOUT_CHAINS[chain]) return { ok: false, error: `unsupported chain — one of: ${Object.keys(PAYOUT_CHAINS).join(", ")}`, status: 400 };
  let recipient: `0x${string}`;
  try {
    recipient = getAddress(input.recipient);
  } catch {
    return { ok: false, error: "invalid recipient address", status: 400 };
  }

  // Compliance pre-gate: a sanctioned/blocklisted recipient is refused before any USDC moves.
  const gate = await assertPayeeCompliant(recipient);
  if (!gate.allowed) return { ok: false, error: `payout blocked by compliance screening — ${gate.screen.reason} (${gate.screen.source})`, status: 403 };

  if (isStub() || !process.env.BUYER_PRIVATE_KEY) {
    return {
      ok: false,
      status: 503,
      error: "cross-chain payout is unavailable on this deployment (keyless / stub) — the full code path is built and settles the moment BUYER_PRIVATE_KEY + a funded Gateway balance are configured",
    };
  }

  try {
    // Ensure the Gateway unified balance can cover the payout, self-funding from the buyer wallet's Arc USDC.
    // If the wallet can't fund it, ensureDeposit throws → caught below as an honest "insufficient balance".
    await ensureDeposit(amount, (amount + 0.05).toString());
    const r = await client().transfer(amount.toString(), chain as never, recipient);
    if (!r.mintTxHash) return { ok: false, error: "transfer returned no destination tx", status: 502 };
    const settled = round6(parseFloat(r.formattedAmount || amount.toString()));
    const explorerUrl = `${PAYOUT_CHAINS[chain].explorer}${r.mintTxHash}`;
    recordPayout({ id: r.mintTxHash, amount: settled, chain, recipient, hash: r.mintTxHash, explorerUrl, at: new Date().toISOString() });
    return { ok: true, hash: r.mintTxHash, chain, label: PAYOUT_CHAINS[chain].label, amount: settled, recipient, explorerUrl };
  } catch (e) {
    // Surface the honest reason — never a fake success. Circle Gateway mints the USDC on the DESTINATION chain
    // from the caller's wallet, so a cross-chain payout needs native gas on that chain; map that revert to an
    // actionable message (a same-chain Arc payout needs only Arc gas, which is why arcTestnet settles here).
    const msg = (e as Error).message || "";
    if (/gas required exceeds allowance|insufficient funds for gas|exceeds allowance \(0\)/i.test(msg) && chain !== ARC.gatewayChainName) {
      return {
        ok: false,
        status: 502,
        error: `cross-chain mint needs native gas on ${PAYOUT_CHAINS[chain].label} — Merit's payout wallet holds none there yet. The full path settles the moment that wallet is topped up with a little ${PAYOUT_CHAINS[chain].label} gas (a faucet drip); a same-chain Arc payout works today.`,
      };
    }
    return { ok: false, error: msg.slice(0, 220), status: 502 };
  }
}

/**
 * Custodial payouts — so a creator's earnings are never stranded in a receive-only wallet whose key was
 * discarded. When a creator onboards WITHOUT proving their own wallet, their citation earnings settle to a
 * Merit-controlled CUSTODIAL wallet and accrue to a per-creator balance here. The creator later PROVES domain
 * ownership (publishes /.well-known/merit.json with their address) and CLAIMS: Merit transfers the accrued
 * USDC from the custodial wallet to their proven wallet, on-chain, and marks it claimed. Real money, real
 * withdrawal — no IOU. The off-chain ledger is store-backed (+ Supabase mirror) and holds no private keys.
 *
 * A creator who supplies their OWN wallet at onboarding bypasses custody entirely (paid directly). Only the
 * auto-assigned (custodial) case accrues here.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC, explorerTx, isStub, round6 } from "./arc";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

export interface CustodyEntry {
  id: string;
  name: string;
  domain?: string; // lowercased; the key a creator proves to claim
  earned: number; // lifetime accrued to custody (USDC)
  claimed: number; // lifetime disbursed on-chain (USDC)
  wallet?: string; // the last wallet claimed to
  lastAt: string;
}
interface CustodyLog {
  entries: Record<string, CustodyEntry>;
}

const DOC = "custody";
const ERC20_TRANSFER = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

let cache: CustodyLog | null = null;
function load(): CustodyLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<CustodyLog>(DOC, { entries: {} });
  if (!value.entries) value.entries = {};
  if (cacheable) cache = value;
  return value;
}

/** Read-your-writes refresh from the durable mirror before an accrual/claim/read, so a warm serverless
 *  instance never disburses against a stale balance. No-op off the ephemeral Supabase mirror. */
export async function refreshCustodyFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<CustodyLog>(DOC);
  if (v && typeof v === "object") {
    if (!v.entries) v.entries = {};
    cache = v;
  }
}

/** The Merit-controlled custodial wallet that HOLDS unclaimed creator earnings (funded, key-bearing). */
export function custodyAddress(): string | null {
  return process.env.CUSTODY_ADDRESS || process.env.BUYER_ADDRESS || null;
}
function custodyKey(): string | undefined {
  return process.env.CUSTODY_KEY || process.env.BUYER_PRIVATE_KEY;
}

/** Record earnings owed to a creator whose payout settled to the custodial wallet. Best-effort; never throws. */
export function accrueCustody(id: string, name: string, amount: number, meta?: { domain?: string }): void {
  if (!(amount > 0)) return;
  const log = load();
  const e = log.entries[id] || { id, name, earned: 0, claimed: 0, lastAt: "" };
  e.name = name || e.name;
  e.earned = round6(e.earned + amount);
  if (meta?.domain) e.domain = meta.domain.toLowerCase();
  e.lastAt = new Date().toISOString();
  log.entries[id] = e;
  cache = log;
  saveDoc(DOC, log);
}

export function custodyUnclaimed(id: string): number {
  const e = load().entries[id];
  return e ? Math.max(0, round6(e.earned - e.claimed)) : 0;
}

/** All custodial creators tied to a domain that still have an unclaimed balance. */
export function custodyByDomain(domain: string): CustodyEntry[] {
  const d = (domain || "").toLowerCase();
  return Object.values(load().entries).filter((e) => (e.domain || "") === d && e.earned - e.claimed > 1e-9);
}
export function custodyEntry(id: string): CustodyEntry | undefined {
  return load().entries[id];
}

/**
 * Disburse a creator's unclaimed balance on-chain: custodial wallet → their proven wallet (USDC transfer).
 * Marks it claimed ONLY after the receipt confirms success, so a failed transfer never zeroes a real balance.
 */
export async function claimCustody(id: string, toWallet: string): Promise<{ tx: string; amount: number; explorerUrl: string } | { error: string; status: number }> {
  const amount = custodyUnclaimed(id);
  if (amount <= 0) return { error: "no unclaimed balance for this creator", status: 400 };
  const pk = custodyKey();
  if (!pk || isStub()) return { error: "on-chain claim is unavailable on this deployment (keyless / stub mode)", status: 503 };
  let to: `0x${string}`;
  try {
    to = getAddress(toWallet);
  } catch {
    return { error: "invalid payout wallet address", status: 400 };
  }
  try {
    const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
    const rpc = process.env.ARC_RPC_URL || ARC.rpcUrl;
    const wallet = createWalletClient({ account, transport: http(rpc) });
    const pub = createPublicClient({ transport: http(rpc) });
    const atomic = BigInt(Math.round(amount * 1e6)); // USDC has 6 decimals
    const hash = await wallet.sendTransaction({
      to: ARC.usdc as `0x${string}`,
      data: encodeFunctionData({ abi: ERC20_TRANSFER, functionName: "transfer", args: [to, atomic] }),
      chain: null,
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") return { error: "the USDC transfer reverted on-chain", status: 502 };
    const log = load();
    const e = log.entries[id];
    if (e) {
      e.claimed = round6(e.claimed + amount);
      e.wallet = to;
      e.lastAt = new Date().toISOString();
      cache = log;
      saveDoc(DOC, log);
    }
    return { tx: hash, amount, explorerUrl: explorerTx(hash) };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 160), status: 502 };
  }
}

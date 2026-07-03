/**
 * Prepaid verification balance (Wave B #5) — "pay only for what verifies," made literal. A principal funds a
 * balance ONCE (a real USDC transfer to the Merit balance wallet, credited only after the on-chain deposit is
 * verified), then verifications burn it down — but ONLY on a citation that VERIFIES. A REFUSED citation costs
 * nothing and stays in the balance, so the status can honestly say "you funded $5, 43 verified, 12 refused cost
 * you $0 — $1.20 still yours." The unused remainder is withdrawable on-chain. No IOU: deposits are proven from
 * chain logs and withdrawals are real transfers; the off-chain ledger only accounts, it holds no keys itself.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC, explorerTx, isStub, round6 } from "./arc";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";
import { deriveWallet, derivePrivateKey, walletSeedConfigured } from "./wallet";
import { serialize } from "./locks";

const USDC_TRANSFER_EVENT = [
  { type: "event", name: "Transfer", inputs: [{ indexed: true, name: "from", type: "address" }, { indexed: true, name: "to", type: "address" }, { indexed: false, name: "value", type: "uint256" }] },
] as const;
const ERC20_TRANSFER = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export interface BalanceEntry {
  id: string; // principal id
  funded: number; // total credited from verified on-chain deposits
  spent: number; // total burned on VERIFIED citations
  withdrawn: number; // total withdrawn on-chain
  charges: number; // count of verified citations that burned balance
  refusedNoCharge: number; // count of refused citations that cost nothing (the refund-to-balance story)
  wallet?: string; // last withdrawal destination
  depositTxs: string[]; // credited deposit tx hashes (idempotency — never double-credit)
  lastAt: string;
}
interface BalanceLog {
  entries: Record<string, BalanceEntry>;
  // GLOBAL idempotency: a deposit tx hash → the principal it was credited to. A tx is creditable at most ONCE,
  // system-wide, so it can never be double-credited across principals.
  credited: Record<string, string>;
}

const DOC = "balance";

/** A principal's UNIQUE deposit address (Merit-controlled, derived from the wallet seed). Because every
 *  principal deposits to its OWN address, crediting checks the transfer is TO this address — so a principal can
 *  never claim another's deposit, and no `from` binding is needed (funding your own address is always yours). */
export function depositAddressFor(principalId: string): string {
  return deriveWallet(principalId).address;
}

let cache: BalanceLog | null = null;
function load(): BalanceLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<BalanceLog>(DOC, { entries: {}, credited: {} });
  if (!value.entries) value.entries = {};
  if (!value.credited) value.credited = {};
  if (cacheable) cache = value;
  return value;
}
export async function refreshBalanceFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<BalanceLog>(DOC);
  if (v && typeof v === "object") {
    if (!v.entries) v.entries = {};
    if (!v.credited) v.credited = {};
    cache = v;
  }
}
function entry(id: string): BalanceEntry {
  const log = load();
  return (log.entries[id] ||= { id, funded: 0, spent: 0, withdrawn: 0, charges: 0, refusedNoCharge: 0, depositTxs: [], lastAt: "" });
}
function persist(): void {
  if (cache) saveDoc(DOC, cache);
}

export interface BalanceStatus {
  funded: number;
  spent: number; // burned on verified citations only
  withdrawn: number;
  available: number;
  charges: number;
  refusedNoCharge: number;
}
export function balanceStatus(id: string): BalanceStatus {
  const e = load().entries[id];
  if (!e) return { funded: 0, spent: 0, withdrawn: 0, available: 0, charges: 0, refusedNoCharge: 0 };
  return { funded: e.funded, spent: e.spent, withdrawn: e.withdrawn, available: availableFor(e), charges: e.charges, refusedNoCharge: e.refusedNoCharge };
}
function availableFor(e: BalanceEntry): number {
  return Math.max(0, round6(e.funded - e.spent - e.withdrawn));
}
export function available(id: string): number {
  const e = load().entries[id];
  return e ? availableFor(e) : 0;
}

/**
 * Credit a deposit by PROVING it on-chain: read the tx receipt and sum the USDC Transfer(s) TO THIS PRINCIPAL'S
 * OWN deposit address, then credit that exact amount. Two integrity guards: (1) the transfer must be to the
 * caller's unique derived address, so one principal can never claim another's deposit; (2) GLOBAL idempotency —
 * a tx hash is creditable at most once system-wide, so it can't be double-credited. No trust: the amount comes
 * from chain logs, not the caller.
 */
export async function creditDeposit(id: string, txHash: string): Promise<{ credited: number; funded: number; available: number } | { error: string; status: number }> {
  if (isStub()) return { error: "on-chain deposits are unavailable on this deployment (stub)", status: 503 };
  if (!walletSeedConfigured()) return { error: "deposits require MERIT_WALLET_SEED (per-principal deposit addresses)", status: 503 };
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { error: "provide a valid deposit tx hash", status: 400 };
  const key = txHash.toLowerCase();
  // Serialize per principal so the check-await-credit is atomic: without this, K concurrent requests for the
  // SAME tx all pass the idempotency guard before any sets it, and all credit — an N-fold inflation. Under the
  // lock the second call re-checks `credited[key]` AFTER the first has set it → 409.
  return serialize("balance:" + id, async () => {
    const log = load();
    if (log.credited[key]) return { error: "this deposit was already credited", status: 409 }; // global — never double-credit
    const addr = depositAddressFor(id); // this principal's unique deposit address
    try {
      const pub = createPublicClient({ transport: http(process.env.ARC_RPC_URL || ARC.rpcUrl) });
      const rc = await pub.getTransactionReceipt({ hash: txHash as `0x${string}` });
      if (rc.status !== "success") return { error: "that deposit transaction did not succeed on-chain", status: 400 };
      const transfers = parseEventLogs({
        abi: USDC_TRANSFER_EVENT,
        logs: rc.logs.filter((l) => getAddress(l.address) === getAddress(ARC.usdc)),
      });
      let total = BigInt(0);
      for (const t of transfers) if (getAddress((t.args as { to: string }).to) === getAddress(addr)) total += (t.args as { value: bigint }).value;
      if (total <= BigInt(0)) return { error: "no USDC transfer to YOUR deposit address was found in that transaction", status: 400 };
      const amount = round6(Number(total) / 1e6);
      const e = entry(id);
      e.funded = round6(e.funded + amount);
      if (!e.depositTxs.includes(key)) e.depositTxs.push(key);
      e.lastAt = new Date().toISOString();
      log.credited[key] = id; // mark this tx globally credited
      persist();
      return { credited: amount, funded: e.funded, available: availableFor(e) };
    } catch (err) {
      return { error: (err as Error).message.slice(0, 160), status: 502 };
    }
  });
}

/**
 * Burn balance for a VERIFIED citation only. Synchronous read-modify-write (no await) so the check and the debit
 * are atomic within an instance and can't over-spend under concurrency. Returns ok:false when the balance can't
 * cover it (the caller then asks the user to top up). Refresh from the mirror before calling on serverless.
 *
 * Cross-instance residual (bounded, low): the durable store mirrors the whole doc last-write-wins, so under
 * genuinely concurrent multi-INSTANCE traffic a stale mirror read could let a near-empty balance fund a few
 * extra sub-cent verifications before the mirror reconciles. Bounded by instance count × price; the durable fix
 * is an atomic per-principal decrement (a counter row), tracked as post-launch hardening — same limitation the
 * other store-backed ledgers document.
 */
export function chargeVerified(id: string, amount: number): { ok: true; charged: number; available: number } | { ok: false; available: number } {
  const e = entry(id);
  const avail = availableFor(e);
  const amt = round6(Math.max(0, amount));
  if (amt <= 0 || avail + 1e-9 < amt) return { ok: false, available: avail };
  e.spent = round6(e.spent + amt);
  e.charges += 1;
  e.lastAt = new Date().toISOString();
  persist();
  return { ok: true, charged: amt, available: availableFor(e) };
}

/**
 * STUB/dev only: credit a SIMULATED deposit (no real USDC moves) so the prepaid flow is fully demoable without
 * funding a wallet. REJECTED on a live (STUB=0) deploy — a real balance requires an on-chain deposit that
 * `creditDeposit` proves from chain logs. Kept explicit + honest, never a silent free credit on real money.
 */
export function simulateDeposit(id: string, amount: number): { credited: number; funded: number; available: number; simulated: true } | { error: string; status: number } {
  if (!isStub()) return { error: "simulated deposits are only allowed in stub/demo mode — send a real USDC deposit and credit it with { action: \"deposit\", txHash }", status: 403 };
  const amt = round6(Math.max(0, amount));
  if (!(amt > 0)) return { error: "amount must be positive", status: 400 };
  const e = entry(id);
  e.funded = round6(e.funded + amt);
  e.lastAt = new Date().toISOString();
  persist();
  return { credited: amt, funded: e.funded, available: availableFor(e), simulated: true };
}

/**
 * Reserve `amount` of a principal's AVAILABLE balance for an off-CHAIN payout (the fiat off-ramp), atomically:
 * under the per-principal lock, check available >= amount and increment `withdrawn` BEFORE the payout is
 * broadcast — so a concurrent charge or on-chain withdrawal can't let the same funds leave twice, and a caller
 * can never cash out more than the unused, funded balance they actually hold. Roll back with
 * releasePayoutReservation if the provider call fails (no funds left the ledger). Refresh from the mirror first.
 */
export async function reserveForPayout(id: string, amount: number): Promise<{ ok: true; available: number } | { ok: false; error: string; status: number }> {
  const amt = round6(Math.max(0, amount));
  if (!(amt > 0)) return { ok: false, error: "amount must be positive", status: 400 };
  return serialize("balance:" + id, async () => {
    const avail = available(id);
    if (avail + 1e-9 < amt) return { ok: false, error: `insufficient balance — you have $${avail} available to cash out (requested $${amt})`, status: 402 };
    const e = entry(id);
    e.withdrawn = round6(e.withdrawn + amt); // reserve synchronously under the lock, before any await/broadcast
    e.lastAt = new Date().toISOString();
    persist();
    return { ok: true, available: availableFor(e) };
  });
}

/** Roll back a payout reservation (call when the off-ramp provider fails after a successful reserveForPayout). */
export function releasePayoutReservation(id: string, amount: number): void {
  const amt = round6(Math.max(0, amount));
  if (!(amt > 0)) return;
  const e = entry(id);
  e.withdrawn = round6(Math.max(0, e.withdrawn - amt));
  persist();
}

/** Record a refused citation that did NOT burn balance — the "$X stayed yours" number. */
export function noteRefused(id: string): void {
  const e = entry(id);
  e.refusedNoCharge += 1;
  persist();
}

/** Withdraw the unused balance on-chain: the principal's OWN derived deposit address → their wallet (real USDC
 *  transfer, signed with the Merit-derived key for that address). Only `available` moves; the spent portion (the
 *  fees Merit earned on verified citations) stays in the derived address. */
export async function withdrawBalance(id: string, toWallet: string): Promise<{ tx: string; amount: number; explorerUrl: string } | { error: string; status: number }> {
  if (isStub()) return { error: "on-chain withdrawal is unavailable on this deployment (stub)", status: 503 };
  if (!walletSeedConfigured()) return { error: "withdrawals require MERIT_WALLET_SEED", status: 503 };
  let to: `0x${string}`;
  try {
    to = getAddress(toWallet);
  } catch {
    return { error: "invalid payout wallet address", status: 400 };
  }
  // Serialize per principal so two withdrawals can't both read the same `available` and each send it. And RESERVE
  // (increment withdrawn) synchronously BEFORE broadcasting, so a concurrent chargeVerified sees the reduced
  // available and we never send more than the principal owns; roll the reservation back if the transfer fails.
  return serialize("balance:" + id, async () => {
    const amount = available(id);
    if (amount <= 0) return { error: "no available balance to withdraw", status: 400 };
    const e = entry(id);
    e.withdrawn = round6(e.withdrawn + amount); // reserve first (sync, no await between read and write)
    persist();
    try {
      const account = privateKeyToAccount(derivePrivateKey(id)); // the principal's own deposit-address key
      const rpc = process.env.ARC_RPC_URL || ARC.rpcUrl;
      const wallet = createWalletClient({ account, transport: http(rpc) });
      const pub = createPublicClient({ transport: http(rpc) });
      const atomic = BigInt(Math.round(amount * 1e6));
      const hash = await wallet.sendTransaction({
        to: ARC.usdc as `0x${string}`,
        data: encodeFunctionData({ abi: ERC20_TRANSFER, functionName: "transfer", args: [to, atomic] }),
        chain: null,
      });
      const rc = await pub.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") {
        e.withdrawn = round6(e.withdrawn - amount); // roll back the reservation
        persist();
        return { error: "the USDC withdrawal reverted on-chain", status: 502 };
      }
      e.wallet = to;
      e.lastAt = new Date().toISOString();
      persist();
      return { tx: hash, amount, explorerUrl: explorerTx(hash) };
    } catch (err) {
      e.withdrawn = round6(e.withdrawn - amount); // roll back the reservation on any failure
      persist();
      return { error: (err as Error).message.slice(0, 160), status: 502 };
    }
  });
}

/** Test seam. */
export function _resetBalance(): void {
  cache = null;
}

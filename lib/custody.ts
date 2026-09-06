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
import { createPublicClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC, explorerTx, isStub, round6 } from "./arc";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";
import { assertPayeeCompliant } from "./compliance";
import { simulateUsdcTransfer } from "./simulate";
import { buildPayoutMemo, sendMemoedBatch, sendMemoedTransfer, type BatchLineInput, type MemoRef } from "./memo";

export interface CustodyEntry {
  id: string;
  name: string;
  domain?: string; // lowercased; the key a creator proves to claim
  earned: number; // lifetime accrued to custody (USDC)
  claimed: number; // lifetime disbursed on-chain (USDC)
  wallet?: string; // the last wallet claimed to
  lastAt: string;
  /** Provenance of the UNCLAIMED balance: one ref per accrual, carrying the verificationId that released it.
   *  This is what the Arc transaction memo publishes on chain when the creator claims — so the payment itself
   *  names the verified work behind it. Cleared on a successful claim; bounded (see MAX_REFS). */
  refs?: MemoRef[];
  /** The `memoId` of the last claim's on-chain memo, when one was written — a bytes32 anyone can use to look
   *  the payment up by `Memo` event, independently of Merit. */
  lastMemoId?: string;
  /** Every on-chain disbursement made to this creator. Without this the largest real settlements Merit makes
   *  would exist only as a running `claimed` total with no tx to check — so the reconciler could not verify
   *  them and a reader could not follow them. Bounded tail. */
  payouts?: CustodyPayout[];
}

export interface CustodyPayout {
  tx: string;
  amount: number;
  to: string;
  at: string;
  memoId?: string;
  memoed: boolean;
}
interface CustodyLog {
  entries: Record<string, CustodyEntry>;
}

const DOC = "custody";
/** Bound the per-creator provenance list so a long-lived custodial balance can't grow the ledger without limit.
 *  On overflow the OLDEST refs are folded into one aggregate ref, which preserves the exact total amount while
 *  dropping only the individual ids — the memo's `n` then honestly describes what its digest actually covers. */
const MAX_REFS = 400;
const FOLD_CHUNK = 100;

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
export function accrueCustody(id: string, name: string, amount: number, meta?: { domain?: string; verificationId?: string; runId?: string }): void {
  if (!(amount > 0)) return;
  const log = load();
  const e = log.entries[id] || { id, name, earned: 0, claimed: 0, lastAt: "" };
  e.name = name || e.name;
  e.earned = round6(e.earned + amount);
  if (meta?.domain) e.domain = meta.domain.toLowerCase();
  // Remember WHICH verification released this money, so the eventual on-chain claim can say so in its memo.
  const refs = (e.refs ||= []);
  refs.push({ v: meta?.verificationId, run: meta?.runId, a: round6(amount), at: Date.now() });
  if (refs.length > MAX_REFS) {
    const folded = refs.splice(0, FOLD_CHUNK);
    refs.unshift({ a: round6(folded.reduce((s, r) => s + r.a, 0)), at: folded[0]?.at });
  }
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

/** Every on-chain custody disbursement Merit has made, newest last — the settlement rows the chain
 *  reconciler checks and the public claim page links. */
export function allCustodyPayouts(): Array<CustodyPayout & { id: string; name: string }> {
  const out: Array<CustodyPayout & { id: string; name: string }> = [];
  for (const e of Object.values(load().entries)) {
    for (const p of e.payouts || []) out.push({ ...p, id: e.id, name: e.name });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Disburse a creator's unclaimed balance on-chain: custodial wallet → their proven wallet (USDC transfer),
 * wrapped in an Arc transaction memo that names the verified work behind it. Marks it claimed ONLY after the
 * receipt confirms success, so a failed transfer never zeroes a real balance.
 *
 * The memo is what makes this more than a bank transfer: `memoId` is derived from the payout's own settlement
 * digest, and `memoData` carries the verificationIds that released the money. Anyone can query the `Memo`
 * event by that id and see which verdicts this USDC paid for — without asking Merit anything. The memo is
 * best-effort by design (see sendMemoedTransfer): if the wrapper can't be used the money still moves, and the
 * result says plainly that it went out unmemoed.
 */
export async function claimCustody(id: string, toWallet: string): Promise<{ tx: string; amount: number; explorerUrl: string; memoed: boolean; memoId: string | null; memoNote: string | null } | { error: string; status: number }> {
  const amount = custodyUnclaimed(id);
  if (amount <= 0) return { error: "no unclaimed balance for this creator", status: 400 };
  let to: `0x${string}`;
  try {
    to = getAddress(toWallet);
  } catch {
    return { error: "invalid payout wallet address", status: 400 };
  }
  // Compliance pre-gate (Phase 7): screen the payee BEFORE anything else — a sanctions/blocklisted recipient is
  // refused so no USDC ever prepares to move to it, making a real disbursement "compliance-cleared AND
  // work-verified". Degrades to the local screen when Circle's Compliance Engine isn't entitled; a DENIED from
  // any source blocks, and the accrued balance is left untouched.
  const gate = await assertPayeeCompliant(to);
  if (!gate.allowed) {
    return { error: `payout blocked by compliance screening — ${gate.screen.reason} (${gate.screen.source})`, status: 403 };
  }
  const pk = custodyKey();
  if (!pk || isStub()) return { error: "on-chain claim is unavailable on this deployment (keyless / stub mode)", status: 503 };
  try {
    const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
    // Settlement pre-flight (Phase 7): dry-run the transfer before broadcasting. A predicted failure (insufficient
    // custodial balance, would-revert, no gas) is caught here so we never waste gas on a doomed tx nor strand the
    // claim. Safety optimisation, not a gate: an inability to simulate (RPC down) does NOT block — only a RAN
    // simulation that predicts failure does. Balance is left untouched on a pre-flight block.
    const sim = await simulateUsdcTransfer({ from: account.address, to, amount });
    if (sim.simulated && !sim.wouldSucceed) {
      return { error: `payout pre-flight predicts failure — ${sim.reason}`, status: 422 };
    }
    const rpc = process.env.ARC_RPC_URL || ARC.rpcUrl;
    const pub = createPublicClient({ transport: http(rpc) });
    const atomic = BigInt(Math.round(amount * 1e6)); // USDC has 6 decimals
    // The provenance behind this exact disbursement — the accruals that make up the unclaimed balance.
    const refs: MemoRef[] = (custodyEntry(id)?.refs || []).slice();
    const memo = buildPayoutMemo({ kind: "custody-claim", id, amount, refs });
    const sent = await sendMemoedTransfer({ account, to, atomic, memo: { memoId: memo.memoId, memoData: memo.memoData } });
    const rc = await pub.waitForTransactionReceipt({ hash: sent.hash });
    if (rc.status !== "success") return { error: "the USDC transfer reverted on-chain", status: 502 };
    const log = load();
    const e = log.entries[id];
    if (e) {
      e.claimed = round6(e.claimed + amount);
      e.wallet = to;
      e.lastAt = new Date().toISOString();
      // The refs are now settled and published on chain — clear them so the next claim's memo covers only the
      // accruals that came after this payment.
      e.refs = [];
      if (sent.memoed) e.lastMemoId = sent.memoId || undefined;
      const payouts = (e.payouts ||= []);
      payouts.push({ tx: sent.hash, amount, to, at: e.lastAt, memoId: sent.memoId || undefined, memoed: sent.memoed });
      if (payouts.length > 100) payouts.splice(0, payouts.length - 100);
      cache = log;
      saveDoc(DOC, log);
    }
    return { tx: sent.hash, amount, explorerUrl: explorerTx(sent.hash), memoed: sent.memoed, memoId: sent.memoId, memoNote: sent.fallbackReason };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 160), status: 502 };
  }
}

export interface BatchClaimLine {
  id: string;
  name: string;
  amount: number;
  memoId: string | null;
}
export interface BatchClaimResult {
  tx: string;
  explorerUrl: string;
  total: number;
  lines: BatchClaimLine[];
  memoed: boolean;
  memoNote: string | null;
}

/**
 * Disburse SEVERAL creators' balances to one proven wallet in a SINGLE Arc transaction.
 *
 * A domain usually holds more than one custodial balance — the source itself, plus a `split:` entry per
 * co-author. Paying those one transaction at a time costs one gas fee each and scatters the payment across
 * k explorer pages. `Multicall3From` collapses them into one transaction while preserving the custodial EOA as
 * `msg.sender` on every subcall, so each creator's USDC `Transfer.from` still reads as Merit's wallet rather
 * than a batching contract — and each line still carries its OWN memo naming the verifications behind it.
 *
 * All-or-nothing (`allowFailure: false`): a half-paid basket would leave the ledger and the chain disagreeing,
 * and a clean retry is strictly better. Returns null when batching does not apply (fewer than two payable
 * lines), so the caller falls back to the single-claim path rather than this silently doing something else.
 */
export async function claimCustodyBatch(ids: string[], toWallet: string): Promise<BatchClaimResult | { error: string; status: number } | null> {
  let to: `0x${string}`;
  try {
    to = getAddress(toWallet);
  } catch {
    return { error: "invalid payout wallet address", status: 400 };
  }
  const payable = ids
    .map((id) => ({ id, entry: custodyEntry(id), amount: custodyUnclaimed(id) }))
    .filter((p) => p.amount > 0 && p.entry);
  if (payable.length < 2) return null; // nothing to batch — the caller uses claimCustody

  // One payee, so one compliance screen covers the whole batch (same posture as the single claim: fail closed).
  const gate = await assertPayeeCompliant(to);
  if (!gate.allowed) return { error: `payout blocked by compliance screening — ${gate.screen.reason} (${gate.screen.source})`, status: 403 };

  const pk = custodyKey();
  if (!pk || isStub()) return { error: "on-chain claim is unavailable on this deployment (keyless / stub mode)", status: 503 };

  const total = round6(payable.reduce((s, p) => s + p.amount, 0));
  try {
    const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);
    // Pre-flight the TOTAL, not each line: k transfers that each pass alone can still overdraw together.
    const sim = await simulateUsdcTransfer({ from: account.address, to, amount: total });
    if (sim.simulated && !sim.wouldSucceed) return { error: `batch payout pre-flight predicts failure — ${sim.reason}`, status: 422 };

    const memos = payable.map((p) => buildPayoutMemo({ kind: "custody-claim", id: p.id, amount: p.amount, refs: (p.entry!.refs || []).slice() }));
    const lines: BatchLineInput[] = payable.map((p, i) => ({
      to,
      atomic: BigInt(Math.round(p.amount * 1e6)),
      memo: { memoId: memos[i].memoId, memoData: memos[i].memoData },
    }));
    const sent = await sendMemoedBatch({ account, lines });
    const pub = createPublicClient({ transport: http(process.env.ARC_RPC_URL || ARC.rpcUrl) });
    const rc = await pub.waitForTransactionReceipt({ hash: sent.hash });
    if (rc.status !== "success") return { error: "the batched USDC payout reverted on-chain", status: 502 };

    const log = load();
    const at = new Date().toISOString();
    for (let i = 0; i < payable.length; i++) {
      const e = log.entries[payable[i].id];
      if (!e) continue;
      e.claimed = round6(e.claimed + payable[i].amount);
      e.wallet = to;
      e.lastAt = at;
      e.refs = [];
      if (sent.memoed) e.lastMemoId = memos[i].memoId;
      const payouts = (e.payouts ||= []);
      payouts.push({ tx: sent.hash, amount: payable[i].amount, to, at, memoId: sent.memoed ? memos[i].memoId : undefined, memoed: sent.memoed });
      if (payouts.length > 100) payouts.splice(0, payouts.length - 100);
    }
    cache = log;
    saveDoc(DOC, log);

    return {
      tx: sent.hash,
      explorerUrl: explorerTx(sent.hash),
      total,
      lines: payable.map((p, i) => ({ id: p.id, name: p.entry!.name, amount: p.amount, memoId: sent.memoed ? memos[i].memoId : null })),
      memoed: sent.memoed,
      memoNote: sent.fallbackReason,
    };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 160), status: 502 };
  }
}

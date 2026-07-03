/**
 * AP2-style signed mandates as a PRECONDITION of the verify gate (Wave D — the biggest bet). This completes the
 * one thing no competitor has: a fully signed, end-to-end chain — human-AUTHORIZED → paid → VERIFIED → settled.
 * A human (or their agent-wallet) signs a mandate authorizing "pay up to $X for verified citations of scope S
 * until time T" (the AP2 Intent→Cart→Payment mandate idea). Merit is the clearing layer AP2/x402 leave open —
 * it answers "was the obligation actually satisfied?" — so a payment settles IFF the mandate is valid (real
 * signature, in-scope, within its cap, unexpired) AND the citation VERIFIES. Either predicate fails → no money
 * moves. The signature is recovered on-chain-style (EIP-191) with viem, so anyone can check the authorization
 * offline; the per-mandate cumulative spend is tracked store-backed so a mandate can't be over-drawn or replayed.
 */
import { getAddress, recoverMessageAddress } from "viem";
import { loadDoc, saveDoc } from "./store";

export interface Mandate {
  type: "citation-payment"; // an AP2-style intent mandate scoped to verified-citation settlement
  authorizer: string; // the address that must have signed this mandate
  maxAmount: number; // total USDC this mandate authorizes (across settlements)
  scope: string; // what it authorizes — e.g. "citation"
  expiresAt: number; // epoch ms
  nonce: string; // unique per mandate (the cumulative-spend + replay key)
}

/** The canonical, deterministic string the authorizer signs (personal_sign / EIP-191). Fixed field order. */
export function mandateMessage(m: Mandate): string {
  return JSON.stringify({
    type: m.type,
    authorizer: getAddress(m.authorizer),
    maxAmount: m.maxAmount,
    scope: m.scope,
    expiresAt: m.expiresAt,
    nonce: m.nonce,
  });
}

interface MandateLog {
  cleared: Record<string, number>; // "authorizer:nonce" -> cumulative USDC CLEARED under this mandate
}
const DOC = "mandates";
let cache: MandateLog | null = null;
function load(): MandateLog {
  if (cache) return cache;
  cache = loadDoc<MandateLog>(DOC, { cleared: {} });
  if (!cache.cleared) cache.cleared = {};
  return cache;
}
// Key the ledger by AUTHORIZER + nonce so one signer's nonce can never consume another signer's cap (a
// client-chosen nonce alone would let authorizer B grief authorizer A by reusing A's nonce string).
function ledgerKey(authorizer: string, nonce: string): string {
  return `${getAddress(authorizer).toLowerCase()}:${nonce}`;
}
export function mandateCleared(authorizer: string, nonce: string): number {
  try {
    return load().cleared[ledgerKey(authorizer, nonce)] || 0;
  } catch {
    return 0;
  }
}

/**
 * Validate a mandate + signature as the PRECONDITION for clearing `amount`. Checks: real signature by the named
 * authorizer, correct scope, not expired, and cumulative-cleared + amount within the mandate's cap (fail-fast;
 * the ATOMIC cap enforcement is chargeMandate). Does NOT record — call chargeMandate after the citation verifies.
 */
export async function verifyMandate(m: Mandate, signature: string, check: { amount: number; scope: string }): Promise<{ ok: true; authorizer: string; remaining: number } | { ok: false; reason: string }> {
  try {
    if (!m || !m.authorizer || !m.nonce) return { ok: false, reason: "missing or malformed mandate" };
    if (m.type !== "citation-payment") return { ok: false, reason: "unsupported mandate type" };
    if (typeof m.expiresAt !== "number" || Date.now() >= m.expiresAt) return { ok: false, reason: "mandate expired" };
    if (m.scope !== check.scope) return { ok: false, reason: `mandate scope '${m.scope}' does not authorize '${check.scope}'` };
    if (!(m.maxAmount > 0)) return { ok: false, reason: "mandate authorizes no amount" };
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({ message: mandateMessage(m), signature: signature as `0x${string}` });
    } catch {
      return { ok: false, reason: "invalid signature encoding" };
    }
    if (getAddress(recovered) !== getAddress(m.authorizer)) return { ok: false, reason: "signature does not match the mandate authorizer" };
    const already = mandateCleared(m.authorizer, m.nonce);
    if (already + check.amount > m.maxAmount + 1e-9) return { ok: false, reason: `amount would exceed the mandate cap ($${m.maxAmount}; $${already} already used)` };
    return { ok: true, authorizer: getAddress(m.authorizer), remaining: Math.round((m.maxAmount - already - check.amount) * 1e6) / 1e6 };
  } catch (e) {
    return { ok: false, reason: (e as Error).message.slice(0, 120) };
  }
}

/**
 * Atomically CHECK the cumulative cap AND record the clearance (no await between → no TOCTOU, so concurrent
 * settles can't over-draw one signed mandate). Call only after the citation verifies. Returns the remaining cap.
 */
export function chargeMandate(authorizer: string, nonce: string, amount: number, maxAmount: number): { ok: true; remaining: number } | { ok: false; reason: string } {
  if (!(amount > 0)) return { ok: false, reason: "invalid amount" };
  const log = load();
  const key = ledgerKey(authorizer, nonce);
  const already = log.cleared[key] || 0;
  if (already + amount > maxAmount + 1e-9) return { ok: false, reason: `mandate cap ($${maxAmount}) reached` };
  log.cleared[key] = Math.round((already + amount) * 1e6) / 1e6;
  cache = log;
  saveDoc(DOC, log);
  return { ok: true, remaining: Math.round((maxAmount - log.cleared[key]) * 1e6) / 1e6 };
}

/** Test seam. */
export function _resetMandates(): void {
  cache = null;
}

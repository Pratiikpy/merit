/**
 * Verify-bound session keys (Wave D #14) — delegation tied to the moat, not generic wallet plumbing. A principal
 * mints a SHORT-LIVED, CAPPED session key that can do exactly ONE thing: spend the principal's prepaid balance
 * through the VERIFY gate (POST /api/verify/balance) — billed only for citations that verify. A session key
 * CANNOT withdraw, deposit, or move funds any other way (those endpoints reject it). So a delegated agent can
 * pay-per-verified-citation on your behalf up to a cap, for a bounded window, and nothing else — the ERC-7715
 * "grant a narrowly-scoped permission" idea, scoped to Merit's verification instead of raw transfers.
 * Store-backed; only the key HASH is persisted (the plaintext is shown once).
 */
import crypto from "node:crypto";
import { loadDoc, saveDoc } from "./store";

export interface Session {
  id: string;
  parentId: string; // the principal whose balance this delegates
  keyHash: string;
  cap: number; // max USDC this session may spend (verify-gated)
  spent: number;
  expiresAt: number; // epoch ms
  createdAt: number;
  label?: string;
  revoked?: boolean;
}
type Store = Record<string, Session>;

const DOC = "sessions";
const KEY_PREFIX = "merit_sess_";

let cache: Store | null = null;
function load(): Store {
  if (cache) return cache;
  cache = loadDoc<Store>(DOC, {});
  return cache;
}
function persist(): void {
  if (cache) saveDoc(DOC, cache);
}
function hash(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

/** A key that LOOKS like a session key (so other endpoints can reject it fast without a store lookup). */
export function isSessionKey(key: string): boolean {
  return typeof key === "string" && key.startsWith(KEY_PREFIX);
}

/** Mint a session key for a principal. Returns the PLAINTEXT once (only its hash is stored). */
export function issueSession(parentId: string, opts: { cap: number; ttlMs: number; label?: string }): { sessionKey: string; id: string; cap: number; expiresAt: number } {
  const store = load();
  const key = KEY_PREFIX + crypto.randomBytes(24).toString("hex");
  const id = "sess_" + crypto.randomBytes(8).toString("hex");
  const cap = Math.max(0, opts.cap);
  const ttl = Math.max(60_000, Math.min(opts.ttlMs, 30 * 24 * 60 * 60 * 1000)); // 1min .. 30d
  const expiresAt = Date.now() + ttl;
  store[id] = { id, parentId, keyHash: hash(key), cap, spent: 0, expiresAt, createdAt: Date.now(), label: (opts.label || "").slice(0, 80) };
  cache = store;
  persist();
  return { sessionKey: key, id, cap, expiresAt };
}

/** Resolve a live (non-revoked, non-expired) session for a plaintext key. */
export function resolveSession(plainKey: string): Session | null {
  if (!isSessionKey(plainKey)) return null;
  const h = hash(plainKey);
  const now = Date.now();
  for (const s of Object.values(load())) {
    if (!s.revoked && s.keyHash === h && now < s.expiresAt) return s;
  }
  return null;
}

/** Charge a verified citation against the session's cap. Synchronous (atomic within an instance — no over-spend). */
export function chargeSession(id: string, amount: number): { ok: true; remaining: number } | { ok: false; reason: string } {
  const store = load();
  const s = store[id];
  const now = Date.now();
  if (!s || s.revoked) return { ok: false, reason: "session not found or revoked" };
  if (now >= s.expiresAt) return { ok: false, reason: "session expired" };
  const amt = Math.max(0, Math.round(amount * 1e6) / 1e6);
  if (s.spent + amt > s.cap + 1e-9) return { ok: false, reason: `session cap ($${s.cap}) reached` };
  s.spent = Math.round((s.spent + amt) * 1e6) / 1e6;
  cache = store;
  persist();
  return { ok: true, remaining: Math.max(0, Math.round((s.cap - s.spent) * 1e6) / 1e6) };
}

/** Give back a session charge (used only if the balance debit that followed it failed) — keeps the two consistent. */
export function refundSession(id: string, amount: number): void {
  const store = load();
  const s = store[id];
  if (!s) return;
  s.spent = Math.max(0, Math.round((s.spent - Math.max(0, amount)) * 1e6) / 1e6);
  cache = store;
  persist();
}

export function revokeSession(id: string, parentId: string): boolean {
  const store = load();
  const s = store[id];
  if (!s || s.parentId !== parentId) return false;
  s.revoked = true;
  cache = store;
  persist();
  return true;
}

export function listSessions(parentId: string): Array<Omit<Session, "keyHash">> {
  const now = Date.now();
  return Object.values(load())
    .filter((s) => s.parentId === parentId)
    .map(({ keyHash: _k, ...rest }) => ({ ...rest, live: !rest.revoked && now < rest.expiresAt } as Omit<Session, "keyHash">));
}

/** Test seam. */
export function _resetSessions(): void {
  cache = null;
}

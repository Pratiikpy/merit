/**
 * Per-principal API-key auth + the fail-closed spend firewall (W2.1).
 *
 * Each external agent/app authenticates with an API key (Authorization: Bearer … or X-Merit-Key). Only the
 * key's SHA-256 hash is stored (lib/store.ts → apikeys.json); the plaintext is shown once at creation. Every
 * principal carries its own USDC budget cap, so the shared buyer wallet can no longer be drained by an open
 * endpoint — spend is bounded per principal, and a run that would exceed a principal's remaining budget is
 * rejected (fail-closed). Auth enforcement is OFF by default (MERIT_REQUIRE_AUTH=1 turns it on) so the
 * keyless demo + smoke keep working; even with auth off, a PROVIDED key is still validated + budget-tracked.
 */
import crypto from "node:crypto";
import { loadDoc, loadDocFromMirror, saveDoc, saveDocNow } from "./store";
import { isStub } from "./arc";

export interface Principal {
  id: string;
  name: string;
  keyHash: string;
  budgetCap: number; // total USDC this principal may spend across runs; 0 = unlimited
  spent: number;
  createdAt: number;
  disabled?: boolean;
}
type Store = Record<string, Principal>; // keyed by principal id

let cache: Store | null = null;
function load(): Store {
  if (cache) return cache;
  cache = loadDoc<Store>("apikeys", {});
  return cache;
}
function persist(store: Store): void {
  saveDoc("apikeys", store);
}

/**
 * Read-your-writes refresh of the API-key store from the durable mirror. WITHOUT this, a key minted on one
 * serverless instance is invisible to other (cold or warm-stale) instances — they read their own local `apikeys`
 * doc and 401 a perfectly valid key. Call it in every keyed route BEFORE authGate, and before minting (so a new
 * key merges onto the current authoritative set instead of clobbering another instance's keys — the same
 * last-writer-wins caveat lib/audit documents). Best-effort; never throws. No-op off the ephemeral mirror.
 */
export async function refreshAuthFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<Store>("apikeys");
  if (v && typeof v === "object") cache = v;
}

export function hashKey(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

/** True when auth is enforced (the fail-closed firewall). Explicitly togglable with MERIT_REQUIRE_AUTH;
 *  otherwise it defaults ON for a real-money (STUB=0) deploy and OFF for the keyless STUB demo/smoke — so a
 *  live deploy can't be drained through an unauthenticated endpoint just because the operator forgot to set it. */
export function authRequired(): boolean {
  if (process.env.MERIT_REQUIRE_AUTH === "1") return true;
  if (process.env.MERIT_REQUIRE_AUTH === "0") return false;
  return !isStub();
}

/** Create a new API key for a principal. Returns the PLAINTEXT key ONCE (only its hash is persisted). */
export function createApiKey(name: string, budgetCap = 0): { key: string; principal: Principal } {
  const store = load();
  const key = "merit_sk_" + crypto.randomBytes(24).toString("hex");
  const id = "prin_" + crypto.randomBytes(8).toString("hex");
  const principal: Principal = {
    id,
    name: name || id,
    keyHash: hashKey(key),
    budgetCap: Math.max(0, budgetCap),
    spent: 0,
    createdAt: Date.now(),
  };
  store[id] = principal;
  persist(store);
  return { key, principal };
}

/**
 * Durably mint a key WITHOUT the last-writer-wins clobber a plain createApiKey suffers under rapid onboarding.
 * createApiKey persists via a DEFERRED, non-awaited blob upsert from a possibly-stale local base — so a mint
 * that reads the mirror microseconds before a prior mint's deferred write lands overwrites the whole apikeys
 * blob and DROPS the earlier key (observed: a freshly onboarded key returns 401 forever). Here every mint does
 * an AWAITED, authoritative read → UNION → write (read-your-writes with loadDocFromMirror), then re-reads to
 * confirm its key survived and retries if a concurrent writer clobbered it. Union preserves every key from both
 * the mirror and the local set, so no principal is lost. Use this for any self-serve / public key minting.
 */
export async function createApiKeyDurable(name: string, budgetCap = 0): Promise<{ key: string; principal: Principal }> {
  const key = "merit_sk_" + crypto.randomBytes(24).toString("hex");
  const id = "prin_" + crypto.randomBytes(8).toString("hex");
  const principal: Principal = { id, name: name || id, keyHash: hashKey(key), budgetCap: Math.max(0, budgetCap), spent: 0, createdAt: Date.now() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const mirror = (await loadDocFromMirror<Store>("apikeys")) || {};
      const merged: Store = { ...mirror, ...(cache || {}), [id]: principal }; // union: never drop a key from either side
      cache = merged;
      await saveDocNow("apikeys", merged); // AWAITED authoritative write — next onboard's read sees this key
      const check = (await loadDocFromMirror<Store>("apikeys")) || {};
      if (check[id]) { cache = check[id] ? { ...check, ...cache } : cache; break; } // our key survived the write
    } catch (e) {
      if (attempt === 2) { console.error("[auth] durable mint persist failed (key valid on this instance):", (e as Error).message); break; }
    }
  }
  return { key, principal };
}

/** Resolve the principal for a plaintext key (by hash), or null if unknown/disabled. */
export function verifyKey(plainKey: string): Principal | null {
  if (!plainKey) return null;
  const h = hashKey(plainKey);
  for (const p of Object.values(load())) if (!p.disabled && p.keyHash === h) return p;
  return null;
}

/** Pull the API key off a request — Authorization: Bearer <key>, or the X-Merit-Key header. */
export function keyFromRequest(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return (req.headers.get("x-merit-key") || "").trim();
}

export function remainingBudget(p: Principal): number {
  if (p.budgetCap <= 0) return Infinity; // 0 = unlimited
  return Math.max(0, p.budgetCap - p.spent);
}

/** Record actual spend against a principal (called after a run settles). Best-effort; never throws. */
export function chargePrincipal(id: string, amount: number): void {
  try {
    const store = load();
    const p = store[id];
    if (!p) return;
    p.spent = Math.round((p.spent + Math.max(0, amount)) * 1e6) / 1e6;
    persist(store);
  } catch (e) {
    console.error("[auth] charge failed:", (e as Error).message);
  }
}

/** Principals without their key hashes — for an admin listing / dashboard. */
export function listPrincipals(): Array<Omit<Principal, "keyHash">> {
  return Object.values(load()).map(({ keyHash: _k, ...rest }) => rest);
}

export interface Guard {
  ok: boolean;
  status?: number;
  error?: string;
  principal?: Principal;
}

/** The fail-closed key gate (no budget check — the caller does that once the run's budget is known). When
 *  auth is required, a missing or invalid key is rejected; otherwise an anonymous request passes (the global
 *  rate limit still bounds it), but a PROVIDED-yet-invalid key is always rejected. */
export function authGate(req: Request): Guard {
  const key = keyFromRequest(req);
  const principal = key ? verifyKey(key) : null;
  if (authRequired()) {
    if (!key) return { ok: false, status: 401, error: "API key required (Authorization: Bearer <key>)" };
    if (!principal) return { ok: false, status: 401, error: "invalid or disabled API key" };
  } else if (key && !principal) {
    return { ok: false, status: 401, error: "invalid or disabled API key" };
  }
  return { ok: true, principal: principal ?? undefined };
}

/** Test seam: drop the in-memory cache so the next read reloads from disk. */
export function _resetAuthCache(): void {
  cache = null;
}

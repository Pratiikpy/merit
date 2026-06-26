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
import { loadDoc, saveDoc } from "./store";

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

export function hashKey(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

/** True when auth is enforced (the fail-closed firewall). Default OFF so the keyless demo/smoke still runs. */
export function authRequired(): boolean {
  return process.env.MERIT_REQUIRE_AUTH === "1";
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

/**
 * Operator safety guard (Wave C #8) — the second predicate on every settlement: money moves only if the
 * citation is VERIFIED *and* the guard allows it. Three layers:
 *   1. Kill-switch — an operator (or the auto-abort below) instantly FREEZES all real settlement.
 *   2. Daily hard cap — a system-wide ceiling on real USDC settled per rolling 24h, across every path.
 *   3. Spend-velocity auto-abort — if real settlement in a short window spikes past a threshold (a runaway loop
 *      or a compromised verifier passing everything), it AUTO-FREEZES, so an anomaly can't drain the wallet
 *      before an operator notices.
 * Store-backed (+ Supabase mirror) so the freeze + the daily total hold across serverless instances. Holds no
 * keys — it only decides whether a settle is ALLOWED, never how one is signed.
 */
import { randomBytes } from "node:crypto";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

interface Spend {
  at: number;
  amount: number;
  id?: string; // present for a RESERVED spend (rolled back with releaseReservation if the settle then fails)
}
interface GuardState {
  frozen: boolean;
  reason?: string;
  by?: string;
  at?: string;
  spends: Spend[]; // rolling 24h window — powers both the daily total and the velocity check
}

const DOC = "guard";
const DAY_MS = 24 * 60 * 60 * 1000;

/** System-wide ceiling on real USDC settled per rolling 24h (operator-set; default $5). */
export function dailyCap(): number {
  const v = Number(process.env.MERIT_DAILY_SPEND_CAP);
  return Number.isFinite(v) && v >= 0 ? v : 5.0;
}
function velocityWindowMs(): number {
  const v = Number(process.env.MERIT_SPEND_VELOCITY_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : 60_000; // 60s
}
/** Max real USDC settled within the velocity window before the circuit breaker auto-freezes (default $1/60s). */
export function velocityCap(): number {
  const v = Number(process.env.MERIT_SPEND_VELOCITY_CAP);
  return Number.isFinite(v) && v > 0 ? v : 1.0;
}

let cache: GuardState | null = null;
function load(): GuardState {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<GuardState>(DOC, { frozen: false, spends: [] });
  if (!value.spends) value.spends = [];
  if (cacheable) cache = value;
  return value;
}
export async function refreshGuardFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<GuardState>(DOC);
  if (v && typeof v === "object") {
    if (!v.spends) v.spends = [];
    cache = v;
  }
}
function persist(): void {
  if (cache) saveDoc(DOC, cache);
}

function sumSince(s: GuardState, now: number, windowMs: number): number {
  const cutoff = now - windowMs;
  let t = 0;
  for (const x of s.spends) if (x.at >= cutoff) t += x.amount;
  return Math.round(t * 1e6) / 1e6;
}

export function isFrozen(): boolean {
  return load().frozen === true;
}

/** Operator freeze — halts all real settlement immediately (also called by the auto-abort with by:"auto"). */
export function freeze(reason: string, by = "operator"): void {
  const s = load();
  s.frozen = true;
  s.reason = reason.slice(0, 200);
  s.by = by;
  s.at = new Date().toISOString();
  cache = s;
  persist();
}
export function unfreeze(by = "operator"): void {
  const s = load();
  s.frozen = false;
  s.reason = `unfrozen by ${by}`;
  s.by = by;
  s.at = new Date().toISOString();
  cache = s;
  persist();
}

/** Can `amount` settle right now? False → the caller holds the payment (verified, but the guard paused it). */
export function canSpend(amount: number, now: number): { ok: boolean; reason?: string } {
  const s = load();
  if (s.frozen) return { ok: false, reason: s.reason || "settlement frozen by operator" };
  if (sumSince(s, now, DAY_MS) + amount > dailyCap() + 1e-9) return { ok: false, reason: `daily spend cap ($${dailyCap()}) reached` };
  return { ok: true };
}

/** Record a real settlement against the guard AND run the velocity circuit breaker (may auto-freeze). */
export function recordSpend(amount: number, now: number): void {
  if (!(amount > 0)) return;
  const s = load();
  s.spends.push({ at: now, amount });
  const cutoff = now - DAY_MS;
  if (s.spends.some((x) => x.at < cutoff)) s.spends = s.spends.filter((x) => x.at >= cutoff);
  // Velocity auto-abort: a burst past the window cap trips the breaker.
  const vWin = velocityWindowMs();
  const recent = sumSince(s, now, vWin);
  if (recent > velocityCap() + 1e-9 && !s.frozen) {
    s.frozen = true;
    s.reason = `auto-frozen: spend velocity $${recent} exceeded $${velocityCap()} in ${Math.round(vWin / 1000)}s`;
    s.by = "auto";
    s.at = new Date().toISOString();
  }
  cache = s;
  persist();
}

/**
 * Atomically CHECK + RESERVE spend in one synchronous step (no await between), so a concurrent caller sees the
 * reduced headroom BEFORE the multi-second on-chain settle — closing the check-then-spend TOCTOU that a bare
 * canSpend→(await)→recordSpend leaves open. On ok, the amount is already recorded (and may trip the velocity
 * breaker); reconcile after settling: releaseReservation(id) then recordSpend(actual), or just releaseReservation(id)
 * if the settle failed. Reserve slightly conservatively (the intended cost) — an over-reserve is always safe.
 */
export function reserveSpend(amount: number, now: number): { ok: boolean; reason?: string; id?: string } {
  if (!(amount > 0)) return { ok: false, reason: "invalid amount" };
  const c = canSpend(amount, now);
  if (!c.ok) return c;
  const s = load();
  const id = randomBytes(8).toString("hex");
  s.spends.push({ at: now, amount, id });
  const cutoff = now - DAY_MS;
  if (s.spends.some((x) => x.at < cutoff)) s.spends = s.spends.filter((x) => x.at >= cutoff);
  const recent = sumSince(s, now, velocityWindowMs());
  if (recent > velocityCap() + 1e-9 && !s.frozen) {
    s.frozen = true;
    s.reason = `auto-frozen: spend velocity $${recent} exceeded $${velocityCap()} in ${Math.round(velocityWindowMs() / 1000)}s`;
    s.by = "auto";
    s.at = new Date().toISOString();
  }
  cache = s;
  persist();
  return { ok: true, id };
}

/** Roll back a reservation by id (the settle it guarded failed, or is being reconciled to the actual amount). */
export function releaseReservation(id: string): void {
  if (!id) return;
  const s = load();
  const before = s.spends.length;
  s.spends = s.spends.filter((x) => x.id !== id);
  if (s.spends.length !== before) {
    cache = s;
    persist();
  }
}

export interface GuardStatus {
  frozen: boolean;
  reason?: string;
  by?: string;
  at?: string;
  spentToday: number;
  dailyCap: number;
  velocityWindowSec: number;
  velocityCap: number;
  velocityNow: number;
}
export function guardStatus(now: number): GuardStatus {
  const s = load();
  return {
    frozen: s.frozen,
    reason: s.reason,
    by: s.by,
    at: s.at,
    spentToday: sumSince(s, now, DAY_MS),
    dailyCap: dailyCap(),
    velocityWindowSec: Math.round(velocityWindowMs() / 1000),
    velocityCap: velocityCap(),
    velocityNow: sumSince(s, now, velocityWindowMs()),
  };
}

/** Test seam. */
export function _resetGuard(): void {
  cache = null;
}

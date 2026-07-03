/**
 * Bounded live-settlement guard for public Merit Links. A Merit Link is a PUBLIC "cite → pay" toll: anyone
 * (a judge scanning the QR on-stage) can settle a real sub-cent USDC nanopayment to a creator whose citation
 * verifies. That is the whole demo — real money moving on Arc from a public button — but a public button that
 * spends from the buyer wallet is also a drain vector. This caps it: a rolling 24h window budget (and a
 * per-settle max), store-backed (+ Supabase mirror) so the cap holds across serverless instances. When the
 * window budget is exhausted the toll does NOT spend on-chain — it accrues the earning to the creator's
 * custody balance instead (still real, still claimable), and the caller reports the pause honestly. Holds no
 * keys; the numbers here only decide whether a settle is allowed, never how one is signed.
 */
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

const DOC = "linkbudget";
const WINDOW_MS = 24 * 60 * 60 * 1000;

interface Spend {
  at: number;
  amount: number;
}
interface Log {
  spends: Spend[];
}

/** Total USDC a public Merit Link may settle on-chain per rolling 24h window (operator-set; default $1.00). */
export function windowCap(): number {
  const v = Number(process.env.MERIT_LINK_MAX_USDC);
  return Number.isFinite(v) && v >= 0 ? v : 1.0;
}
/** The most a single toll settle may move (guards against one fat request; default $0.05 covers every seed price). */
export function perSettleCap(): number {
  const v = Number(process.env.MERIT_LINK_MAX_SETTLE);
  return Number.isFinite(v) && v > 0 ? v : 0.05;
}

let cache: Log | null = null;
function load(): Log {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<Log>(DOC, { spends: [] });
  if (!value.spends) value.spends = [];
  if (cacheable) cache = value;
  return value;
}

/** Read-your-writes refresh before a cap check on serverless, so a warm instance can't exceed the window cap
 *  by pricing against a stale (empty) spend log. No-op off the ephemeral Supabase mirror. */
export async function refreshLinkBudgetFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<Log>(DOC);
  if (v && Array.isArray(v.spends)) cache = v;
}

function prune(log: Log, now: number): void {
  const cutoff = now - WINDOW_MS;
  if (log.spends.some((s) => s.at < cutoff)) log.spends = log.spends.filter((s) => s.at >= cutoff);
}

/** USDC already settled by public tolls in the trailing 24h. */
export function spentInWindow(now: number): number {
  const log = load();
  const cutoff = now - WINDOW_MS;
  const total = log.spends.reduce((a, s) => (s.at >= cutoff ? a + s.amount : a), 0);
  return Math.round(total * 1e6) / 1e6;
}

export function remainingInWindow(now: number): number {
  return Math.max(0, Math.round((windowCap() - spentInWindow(now)) * 1e6) / 1e6);
}

/** May a toll settle `amount` right now? False → the caller falls back to custody accrual (no on-chain spend). */
export function canSettle(amount: number, now: number): boolean {
  if (!(amount > 0)) return false;
  if (amount > perSettleCap() + 1e-9) return false;
  return spentInWindow(now) + amount <= windowCap() + 1e-9;
}

/** Record an actual on-chain toll settle against the window budget. Best-effort; never throws. */
export function recordSettle(amount: number, now: number): void {
  if (!(amount > 0)) return;
  try {
    const log = load();
    log.spends.push({ at: now, amount });
    prune(log, now);
    cache = log;
    saveDoc(DOC, log);
  } catch (e) {
    console.error("[linkbudget] record failed:", (e as Error).message);
  }
}

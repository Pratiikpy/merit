/**
 * Agent-labor market counter — the agent-to-agent side of Merit's economy: external agents paying Merit's
 * specialist agents over x402. Tracked SEPARATELY from the proof-of-citation creator ledger (lib/ledger.ts):
 * these are real on-chain Circle Gateway settlements but are NOT judge-gated, so they must never inflate the
 * verified-citation total. Surfaced as a distinct, clearly-labeled field on /api/metrics. Durable via the
 * store (local file + optional Supabase mirror). Best-effort; never throws into a settled payment.
 */
import { loadDocFresh, saveDoc } from "./store";

export interface LaborLedger {
  settlements: number; // cumulative x402 agent-labor settlements
  volumeUsdc: number; // cumulative USDC settled
  payers: string[]; // distinct agent wallets that paid (bounded)
  specialists: string[]; // distinct specialists paid
  lastAt: number;
}

const empty = (): LaborLedger => ({ settlements: 0, volumeUsdc: 0, payers: [], specialists: [], lastAt: 0 });
const MAX_PAYERS = 10000; // bound the distinct-wallet array

let cache: LaborLedger | null = null;
function load(): LaborLedger {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<LaborLedger>("agentlabor", empty());
  if (cacheable) cache = value;
  return value;
}

/** Record one settled x402 agent-labor payment. Cumulative count/volume only grow. */
export function recordLaborSettlement(e: { payer: string; specialist: string; amount: number }): void {
  try {
    if (!(e.amount > 0)) return;
    const l = load();
    l.settlements += 1;
    l.volumeUsdc = Math.round((l.volumeUsdc + e.amount) * 1e6) / 1e6;
    const p = (e.payer || "").toLowerCase();
    if (p && p !== "unknown" && !l.payers.includes(p) && l.payers.length < MAX_PAYERS) l.payers.push(p);
    if (e.specialist && !l.specialists.includes(e.specialist)) l.specialists.push(e.specialist);
    l.lastAt = Date.now();
    saveDoc("agentlabor", l);
  } catch {
    /* best-effort — never break a settled payment on bookkeeping */
  }
}

/** The cumulative agent-labor totals for /api/metrics (clearly distinct from verified creator settlements). */
export function laborTotals(): { settlements: number; volumeUsdc: number; distinctAgents: number; distinctSpecialists: number } {
  const l = load();
  return {
    settlements: l.settlements,
    volumeUsdc: l.volumeUsdc,
    distinctAgents: l.payers.length,
    distinctSpecialists: l.specialists.length,
  };
}

/** Backfill seam — set the ledger from an external computation (e.g. the multi-pay settlements file). */
export function setLaborLedger(l: LaborLedger): void {
  cache = l;
  saveDoc("agentlabor", l);
}

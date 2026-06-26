/**
 * Cross-run settlement memory — the substrate for learned trust (#11) and the prediction-market
 * resolution prior (#18). Append-only per-source records in `.data/history.json`, atomic-write like the
 * registry, capped to a recent tail. Key-free by construction (source ids + outcomes only). Best-effort:
 * a persistence failure logs and is swallowed, never breaking a run.
 */
import { loadDoc, saveDoc } from "./store";

export interface SettlementRecord {
  runId: string;
  sourceId: string;
  cited: boolean;
  released: boolean;
  amount: number;
  confidence: number;
  reason: string;
  at: number;
}

export interface HistoryStats {
  runs: number;
  releaseRate: number; // fraction of CITED records that released
  avgConfidence: number; // mean confidence across all records
  totalEarned: number;
}

const MAX_PER_SOURCE = 200; // keep a recent tail; learned trust weights recency anyway
type Store = Record<string, SettlementRecord[]>;
let cache: Store | null = null;

// State lives in the durable document store (lib/store.ts): a sync local file + an optional Supabase mirror.
function load(): Store {
  if (cache) return cache;
  cache = loadDoc<Store>("history", {});
  return cache;
}

function persist(store: Store): void {
  saveDoc("history", store);
}

/** Append a source's settlement outcome (once per source per run). Never throws into a run. */
export function recordSettlement(rec: SettlementRecord): void {
  try {
    const store = load();
    const list = store[rec.sourceId] || (store[rec.sourceId] = []);
    list.push(rec);
    if (list.length > MAX_PER_SOURCE) list.splice(0, list.length - MAX_PER_SOURCE);
    persist(store);
  } catch (e) {
    console.error("[history] record failed:", (e as Error).message);
  }
}

/** A source's most recent records, newest last. */
export function readHistory(sourceId: string, n = MAX_PER_SOURCE): SettlementRecord[] {
  const list = load()[sourceId] || [];
  return n >= list.length ? list.slice() : list.slice(list.length - n);
}

/** Aggregate trust signals from a source's history — drives #11 learned trust. */
export function historyStats(sourceId: string): HistoryStats {
  const list = load()[sourceId] || [];
  if (list.length === 0) return { runs: 0, releaseRate: 0, avgConfidence: 0, totalEarned: 0 };
  const cited = list.filter((r) => r.cited);
  const released = cited.filter((r) => r.released).length;
  const sumConf = list.reduce((a, r) => a + (r.confidence || 0), 0);
  const earned = list.reduce((a, r) => a + (r.released ? r.amount : 0), 0);
  return {
    runs: list.length,
    releaseRate: cited.length ? released / cited.length : 0,
    avgConfidence: sumConf / list.length,
    totalEarned: earned,
  };
}

/** Learned trust (#11) — the Beta-Bernoulli posterior mean of a source's release rate (cited → released),
 *  with a uniform Beta(1,1) prior. A never-seen source starts NEUTRAL (0.5) and converges to its true rate
 *  as evidence accumulates across runs, so Merit favors sources that consistently earned and de-trusts
 *  repeat mis-citers — reputation that compounds with use (the PRD's network moat). */
export function learnedTrust(sourceId: string): number {
  const list = load()[sourceId] || [];
  const cited = list.filter((r) => r.cited);
  const released = cited.filter((r) => r.released).length;
  return (released + 1) / (cited.length + 2);
}

/** Test seam: drop the in-memory cache so the next read reloads from disk. */
export function _resetHistoryCache(): void {
  cache = null;
}

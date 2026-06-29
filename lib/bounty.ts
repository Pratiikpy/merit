/**
 * Adversarial bounty arena (#8). Anyone can submit a (source, claim) trying to fool the Auditor into PAYING
 * a bad citation. Merit runs the full layered Auditor and records the outcome: a SUPPORTED verdict on an
 * adversarial submission is a candidate moat-defect ("fooled"); a REFUSED is the moat holding. The board
 * aggregates a live `foolRate` — judge-eval that never stops, crowdsourced. Append-only in `.data/bounty.json`,
 * atomic-write, best-effort (never throws into a request).
 */
import { loadDoc, saveDoc } from "./store";

export interface BountyEntry {
  source: string;
  claim: string;
  verdict: "SUPPORTED" | "REFUSED";
  fooled: boolean; // SUPPORTED on an adversarial submission — a candidate moat defect
  by: string; // deterministic check or LLM judge
  at: number;
}

export interface BountyStats {
  total: number;
  fooled: number;
  held: number;
  foolRate: number; // fooled / total
}

const MAX_ENTRIES = 500;

// Persisted through the durable store (`.data/bounty.json` + the optional Supabase mirror), so live attack
// attempts survive a serverless cold start instead of resetting to 0 on every redeploy.
function load(): BountyEntry[] {
  return loadDoc<BountyEntry[]>("bounty", []);
}

export function recordBounty(entry: BountyEntry): void {
  const list = load();
  list.push(entry);
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
  saveDoc("bounty", list);
}

export function readBounties(n = MAX_ENTRIES): BountyEntry[] {
  const list = load();
  return (n >= list.length ? list.slice() : list.slice(list.length - n)).reverse(); // newest first
}

export function bountyStats(list: BountyEntry[] = load()): BountyStats {
  const total = list.length;
  const fooled = list.filter((e) => e.fooled).length;
  return { total, fooled, held: total - fooled, foolRate: total ? fooled / total : 0 };
}

/** Test seam (kept for API compatibility): the store reads from disk each call, so there is no cache to drop. */
export function _resetBountyCache(): void {
  /* no-op */
}

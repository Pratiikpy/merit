/**
 * Adversarial bounty arena (#8). Anyone can submit a (source, claim) trying to fool the Auditor into PAYING
 * a bad citation. Merit runs the full layered Auditor and records the outcome: a SUPPORTED verdict on an
 * adversarial submission is a candidate moat-defect ("fooled"); a REFUSED is the moat holding. The board
 * aggregates a live `foolRate` — judge-eval that never stops, crowdsourced. Append-only in `.data/bounty.json`,
 * atomic-write, best-effort (never throws into a request).
 */
import fs from "node:fs";
import path from "node:path";

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
let cache: BountyEntry[] | null = null;

function dataDir(): string {
  return process.env.MERIT_DATA_DIR || path.join(process.cwd(), ".data");
}
function dataFile(): string {
  return path.join(dataDir(), "bounty.json");
}

function load(): BountyEntry[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(dataFile(), "utf-8")) as BountyEntry[];
  } catch {
    cache = [];
  }
  return cache;
}

export function recordBounty(entry: BountyEntry): void {
  try {
    const list = load();
    list.push(entry);
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    fs.mkdirSync(dataDir(), { recursive: true });
    const file = dataFile();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error("[bounty] record failed:", (e as Error).message);
  }
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

/** Test seam: drop the in-memory cache so the next read reloads from disk. */
export function _resetBountyCache(): void {
  cache = null;
}

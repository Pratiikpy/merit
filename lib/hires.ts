/**
 * External-hire log (be-the-best Bet 2) — the honest, unfakeable traction signal.
 *
 * The red-team's verdict: a counter you control, fed by a daemon you run, a faucet wallet you fund, paying
 * creators you onboarded, is wash-trading the exact metric the 30% rule exists to catch. The ONLY signal a
 * traction judge can't dismiss is OTHER agents hiring Merit unprompted. This append-only log records every
 * run authenticated by a third-party API key (a principal that is NOT Merit's own anonymous path) — the
 * cross-hires that count. Persisted via the durable store; never throws into a run.
 */
import { loadDoc, saveDoc } from "./store";

export interface ExternalHire {
  principalId: string;
  principalName: string;
  released: number;
  at: number;
  runId?: string;
}

interface Store {
  hires: ExternalHire[];
  count: number; // monotonic total
  principals: string[]; // distinct principal ids that ever hired Merit
}

const MAX = 500;
let cache: Store | null = null;
function load(): Store {
  if (cache) return cache;
  cache = loadDoc<Store>("hires", { hires: [], count: 0, principals: [] });
  return cache;
}

/** Record an external (authenticated-principal) hire. Monotonic count + distinct-principal tracking. */
export function recordExternalHire(h: ExternalHire): void {
  try {
    const s = load();
    s.hires.push(h);
    s.count += 1;
    if (!s.principals.includes(h.principalId)) s.principals.push(h.principalId);
    if (s.hires.length > MAX) s.hires.splice(0, s.hires.length - MAX);
    saveDoc("hires", s);
  } catch (e) {
    console.error("[hires] record failed:", (e as Error).message);
  }
}

/** The external-demand summary: total hires, distinct external principals, USDC they made Merit settle. */
export function externalHires(n = 100): {
  count: number;
  distinctPrincipals: number;
  totalReleased: number;
  recent: ExternalHire[];
} {
  const s = load();
  const totalReleased = Math.round(s.hires.reduce((a, h) => a + (h.released || 0), 0) * 1e6) / 1e6;
  return { count: s.count, distinctPrincipals: s.principals.length, totalReleased, recent: s.hires.slice(-n) };
}

/** Test seam: drop the in-memory cache so the next read reloads from disk. */
export function _resetHiresCache(): void {
  cache = null;
}

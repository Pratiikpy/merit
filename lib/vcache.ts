/**
 * Verified-citation cache (Wave A #1) — the margin engine of pay-per-use. Verifying a (claim, source) pair
 * runs the expensive stack (NLI + adversarial judge); the SAME pair verified again within a TTL returns the
 * already-signed verdict instead of re-running it. The cache key is a hash of the exact (claim, source), so a
 * changed source produces a different key and RE-VERIFIES automatically — we never serve a stale verdict for a
 * mutated source. It caches the PROOF (the signed verdict), never a replayable payment: a cache hit still lets
 * the caller settle fresh, it only skips the recompute. Store-backed (+ Supabase mirror); holds no keys.
 *
 * Honesty note: a cache hit returns the ORIGINAL signed verdict verbatim (its real `verifiedAt`, its real
 * signature) with a `cached: true` marker on the API envelope only — the signed body is never altered, so the
 * offline signer-recovery still checks out. "Savings" is reported as re-verifications AVOIDED (a true count),
 * with an optional nominal compute-cost estimate that is clearly labelled an estimate.
 */
import { createHash } from "node:crypto";
import { isVerifyError, type Verdict, type VerifyOutcome } from "./verify/engine";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

interface CacheEntry {
  key: string;
  verdict: Verdict;
  hits: number; // re-verifications this entry avoided
  firstAt: string; // when first cached (TTL is measured from here — freshness, not recency)
  lastAt: string;
}
interface CacheLog {
  entries: Record<string, CacheEntry>;
  hits: number; // lifetime re-verifications avoided (survives entry eviction)
}

const DOC = "vcache";
const MAX_ENTRIES = 5000;

function ttlMs(): number {
  const v = Number(process.env.MERIT_VCACHE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 24 * 60 * 60 * 1000; // default 24h
}
/** Nominal compute cost avoided per re-verification (NLI + judge), for an HONESTLY-LABELLED savings estimate. */
function costPerVerify(): number {
  const v = Number(process.env.MERIT_VCACHE_COST_USD);
  return Number.isFinite(v) && v >= 0 ? v : 0.0018;
}

let cache: CacheLog | null = null;
function load(): CacheLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<CacheLog>(DOC, { entries: {}, hits: 0 });
  if (!value.entries) value.entries = {};
  if (typeof value.hits !== "number") value.hits = 0;
  if (cacheable) cache = value;
  return value;
}

/** Read-your-writes refresh from the durable mirror (a warm instance would otherwise miss cross-instance hits). */
export async function refreshVcacheFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<CacheLog>(DOC);
  if (v && typeof v === "object") {
    if (!v.entries) v.entries = {};
    if (typeof v.hits !== "number") v.hits = 0;
    cache = v;
  }
}

/**
 * Deterministic key over the EXACT (claim, source). LENGTH-PREFIXED so the (claim|source) boundary is
 * unambiguous: no interior character — not a space, not even a NUL — can shift the split point to make a
 * DIFFERENT pair hash the same. A plain separator is collision-prone (a shared separator char inside a field
 * lets ("a b","c") and ("a","b c") both serialize to "a b c"); length-prefixing makes the mapping injective,
 * so a poisoned verdict can never be served for a pair the caller never submitted.
 */
export function cacheKey(claim: string, source: string): string {
  const c = (claim || "").trim();
  const s = (source || "").trim();
  return createHash("sha256")
    .update(`${c.length} `)
    .update(c)
    .update(` ${s.length} `)
    .update(s)
    .digest("hex");
}

function evictIfNeeded(log: CacheLog): void {
  const keys = Object.keys(log.entries);
  if (keys.length <= MAX_ENTRIES) return;
  // Evict the oldest by firstAt (freshness-ordered) down to the cap.
  keys
    .sort((a, b) => Date.parse(log.entries[a].firstAt) - Date.parse(log.entries[b].firstAt))
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach((k) => delete log.entries[k]);
}

/**
 * Verify with the cache in front. On a fresh, non-expired hit returns the stored signed verdict and records the
 * avoided re-verification; otherwise runs `run()` and caches a successful verdict. Errors are never cached (a
 * keyless 503 or a bad-input 400 must be able to succeed on a later, better-configured call).
 */
export async function verifyWithCache(
  claim: string,
  source: string,
  run: () => Promise<VerifyOutcome>,
  opts?: { cache?: boolean },
): Promise<{ outcome: VerifyOutcome; cached: boolean }> {
  if (opts?.cache === false) return { outcome: await run(), cached: false };
  const key = cacheKey(claim, source);
  const now = Date.now();

  const log = load();
  const hit = log.entries[key];
  if (hit && now - Date.parse(hit.firstAt) <= ttlMs()) {
    hit.hits += 1;
    hit.lastAt = new Date(now).toISOString();
    log.hits += 1;
    cache = log;
    try {
      saveDoc(DOC, log);
    } catch {
      /* recording a hit is best-effort; the cached verdict is still valid */
    }
    return { outcome: { verdict: hit.verdict }, cached: true };
  }

  const outcome = await run();
  if (!isVerifyError(outcome)) {
    try {
      const iso = new Date(now).toISOString();
      log.entries[key] = { key, verdict: outcome.verdict, hits: 0, firstAt: iso, lastAt: iso };
      evictIfNeeded(log);
      cache = log;
      saveDoc(DOC, log);
    } catch {
      /* caching failure must never fail a verification */
    }
  }
  return { outcome, cached: false };
}

export interface CacheStats {
  entries: number; // distinct (claim, source) proofs currently cached
  reverificationsAvoided: number; // lifetime cache hits — a true count
  estSavedUsd: number; // hits × nominal per-verify compute cost — an ESTIMATE, labelled as such
  costPerVerifyUsd: number;
}
export function cacheStats(): CacheStats {
  const log = load();
  const hits = log.hits || 0;
  return {
    entries: Object.keys(log.entries).length,
    reverificationsAvoided: hits,
    estSavedUsd: Math.round(hits * costPerVerify() * 1e6) / 1e6,
    costPerVerifyUsd: costPerVerify(),
  };
}

/** Test seam: drop the in-memory cache so the next read reloads from the store. */
export function _resetVcache(): void {
  cache = null;
}

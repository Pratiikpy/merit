/**
 * Run rate limiting — the /api/run endpoint moves real USDC, so this guards the
 * buyer's wallet. Two layers:
 *   - a per-IP cooldown (first-line, but `x-forwarded-for` is client-controlled,
 *     so an attacker can spoof a fresh IP per request and bypass it), and
 *   - a global sliding-window cap that is NOT keyed on the spoofable IP, so total
 *     fund-spend is bounded regardless of IP spoofing.
 */
const RUN_COOLDOWN_MS = 8000;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX_RUNS = 15;
// Concurrency cap: how many runs may settle against the shared buyer wallet AT ONCE.
// The per-run budget cap is local to each run, so without this, concurrent runs could
// collectively overspend the wallet (security review #3). Sequential demo/CI runs never
// hit this; it only bounds parallel/abusive load.
const MAX_CONCURRENT_RUNS = 4;

const lastRun = new Map<string, number>();
const recentRuns: number[] = [];
let activeRuns = 0;

export interface RateDecision {
  allowed: boolean;
  status?: number; // 429 = per-IP cooldown, 503 = global cap
  retryMs?: number;
}

/** Check (and, when allowed, record) a run attempt. `now` is injected for testability. */
export function checkRunLimit(ip: string, now: number): RateDecision {
  const prev = lastRun.get(ip);
  // Only a previously-seen IP can be on cooldown (avoids a spurious block when the
  // process clock is small; a brand-new IP is always allowed through the per-IP gate).
  if (prev !== undefined && now - prev < RUN_COOLDOWN_MS) {
    return { allowed: false, status: 429, retryMs: RUN_COOLDOWN_MS - (now - prev) };
  }
  // Global sliding window — bypass-proof (not keyed on the spoofable client IP).
  while (recentRuns.length && now - recentRuns[0] > GLOBAL_WINDOW_MS) recentRuns.shift();
  if (recentRuns.length >= GLOBAL_MAX_RUNS) {
    return { allowed: false, status: 503, retryMs: 5000 };
  }
  recentRuns.push(now);
  lastRun.set(ip, now);
  // Evict stale IPs so the cooldown map can't grow unbounded on a long-lived deploy. Safe by
  // construction: the eviction age (GLOBAL_WINDOW_MS, 60s) far exceeds the cooldown (8s), so an IP
  // still within its active cooldown is NEVER evicted — it can't be freed early to re-spam the gate.
  if (lastRun.size > 50) for (const [k, t] of lastRun) if (now - t > GLOBAL_WINDOW_MS) lastRun.delete(k);
  return { allowed: true };
}

// Gate the LLM-bearing re-audit endpoint (/api/challenge) by a bypass-proof GLOBAL sliding window only.
// Deliberately NO per-IP cooldown: a sequential legit client — judge-eval fires 16 back-to-back calls —
// would cascade-429 the instant any single response is fast (a fast 429/503 makes the next call land inside
// the window). Concurrency + provider-load are already bounded by the LLM semaphore + circuit breaker; this
// caps total provider VOLUME, which is what "LLM-bearing endpoints are rate-limited" (SECURITY.md) needs.
const CHALLENGE_GLOBAL_MAX = 40;
const recentChallenges: number[] = [];

/** Check (and, when allowed, record) a challenge/re-audit attempt — global volume cap, no per-IP cascade. */
export function checkChallengeLimit(now: number): RateDecision {
  while (recentChallenges.length && now - recentChallenges[0] > GLOBAL_WINDOW_MS) recentChallenges.shift();
  if (recentChallenges.length >= CHALLENGE_GLOBAL_MAX) return { allowed: false, status: 503, retryMs: 3000 };
  recentChallenges.push(now);
  return { allowed: true };
}

/** Acquire a concurrency slot before a run settles money. Returns false at capacity.
 *  MUST be paired with releaseRunSlot() in a finally (the route uses a once-flag so a
 *  disconnect can't leak a slot). */
export function tryAcquireRunSlot(): boolean {
  if (activeRuns >= MAX_CONCURRENT_RUNS) return false;
  activeRuns++;
  return true;
}

/** Release a concurrency slot when a run ends (normal, error, or client disconnect). */
export function releaseRunSlot(): void {
  if (activeRuns > 0) activeRuns--;
}

/** Test seam: clear internal state between cases. */
export function _resetRateLimit(): void {
  lastRun.clear();
  recentRuns.length = 0;
  activeRuns = 0;
  recentChallenges.length = 0;
}

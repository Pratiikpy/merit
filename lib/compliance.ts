/**
 * Enterprise compliance pre-gate (HUB-PLAN Phase 7) — a KYT/sanctions screen fused with the verify gate so a
 * Merit settlement becomes "compliance-cleared AND work-verified": before real USDC moves to a payee address,
 * the recipient is screened against Circle's Compliance Engine (Transaction Screening API) for sanctions /
 * terrorist-financing / illicit-behavior risk. A DENIED payee is blocked; a REVIEW is flagged. This is the
 * enterprise ask (regulated buyers name compliance, not crypto) built the moat-fused way — it screens the payee
 * of a VERIFIED settlement, never a generic standalone AML product.
 *
 * REAL endpoint (verified against Circle docs): POST https://api.circle.com/v1/w3s/compliance/screening/addresses
 * { idempotencyKey, address, chain } → { result: "APPROVED"|"DENIED", decision:{ ruleName, actions:[FREEZE_WALLET/
 * DENY/REVIEW], reasons:[{ riskScore, riskCategories }] } }. Compliance Engine is entitlement-gated ("eligible
 * customers"), so this degrades gracefully: with no key / not entitled / any error, a DETERMINISTIC local screen
 * decides (operator denylist + malformed-address guard + Circle's documented testnet address suffixes), and the
 * result is honestly labelled `source:"local"`. HONESTY: an APPROVED from the local screen is NOT a sanctions
 * clearance — only a `source:"circle"` APPROVED is (`cleared`). We never present "no local rule matched" as a
 * vendor clearance. Decisions are signed (offline-auditable) and logged for enterprise export.
 */
import { getAddress } from "viem";
import { signReceipt, verificationId } from "./receipt";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

export type Decision = "APPROVED" | "REVIEW" | "DENIED";

export interface ScreenResult {
  address: string; // checksummed when valid, else the raw input
  decision: Decision;
  cleared: boolean; // TRUE only for a real Circle APPROVED — a local APPROVED is "no rule matched", NOT a clearance
  ruleName: string | null;
  riskScore: string | null; // e.g. BLOCKLIST / SEVERE / HIGH / LOW
  riskCategories: string[]; // e.g. ["SANCTIONS"]
  actions: string[]; // Circle recommendations: FREEZE_WALLET / DENY / REVIEW
  source: "circle" | "local";
  basis: string; // human-readable why (vendor rule, operator denylist, malformed, test-suffix, no-rule)
  chain: string;
  screenedAt: string;
  reason: string;
  signer?: string;
  signature?: string;
  screeningId?: `0x${string}`;
}

const CIRCLE_SCREEN_URL = "https://api.circle.com/v1/w3s/compliance/screening/addresses";
const SCREEN_TIMEOUT_MS = 12_000;

export function complianceConfigured(): boolean {
  // Opt-in: the live Circle screen runs only when a key is present AND not explicitly disabled. Off → local screen.
  return !!process.env.CIRCLE_API_KEY && process.env.MERIT_COMPLIANCE !== "0";
}
function screenChain(): string {
  // Circle's chain identifier (e.g. ETH-SEPOLIA). Sanctions/ownership risk is largely chain-independent, so this
  // is configurable and defaults to a testnet chain for the screening call.
  return process.env.MERIT_COMPLIANCE_CHAIN || "ETH-SEPOLIA";
}

function isHexAddress(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

// ---- operator denylist (store-backed, mirrored) ---------------------------------------------------------

interface Denylist { addresses: string[] } // lowercased
const DENY_DOC = "compliance_denylist";
let denyCache: Denylist | null = null;
function loadDeny(): Denylist {
  if (denyCache) return denyCache;
  const { value, cacheable } = loadDocFresh<Denylist>(DENY_DOC, { addresses: [] });
  if (!Array.isArray(value.addresses)) value.addresses = [];
  if (cacheable) denyCache = value;
  return value;
}
export function denylist(): string[] {
  return [...loadDeny().addresses];
}
// Evict every cache-key variant for an address (the key is config+chain prefixed), so a denylist change takes
// effect immediately regardless of the current config/chain that keyed a prior entry.
function evictAddress(a: string): void {
  for (const k of [...cache.keys()]) if (k.endsWith(`|${a}`)) cache.delete(k);
}

/**
 * Add to the operator denylist with a READ-BACK-MERGE against the authoritative mirror (C2): the denylist is a
 * whole-document upsert, so a naive push-onto-local-then-save can clobber another instance's entries — or, if the
 * local view is a non-cacheable empty fallback (mirror-refresh failed), WIPE the entire mirrored denylist. Merging
 * the current mirror set before persisting makes an add strictly additive and prevents the wipe. (Residual limit,
 * as in lib/audit: truly-simultaneous writes still race a single row; the durable fix is an append-only table.)
 */
export async function addToDenylist(address: string): Promise<{ ok: boolean; error?: string }> {
  if (!isHexAddress(address)) return { ok: false, error: "not a valid 0x address" };
  const a = address.toLowerCase();
  const mirror = await loadDocFromMirror<Denylist>(DENY_DOC).catch(() => null);
  const merged = new Set<string>([...(mirror?.addresses || []), ...loadDeny().addresses, a]);
  const d: Denylist = { addresses: [...merged] };
  denyCache = d;
  saveDoc(DENY_DOC, d);
  evictAddress(a); // drop any cached vendor APPROVED so the new denylist entry takes effect immediately
  return { ok: true };
}
export async function removeFromDenylist(address: string): Promise<{ ok: boolean }> {
  const a = address.toLowerCase();
  const mirror = await loadDocFromMirror<Denylist>(DENY_DOC).catch(() => null);
  const merged = new Set<string>([...(mirror?.addresses || []), ...loadDeny().addresses]);
  merged.delete(a);
  const d: Denylist = { addresses: [...merged] };
  denyCache = d;
  saveDoc(DENY_DOC, d);
  evictAddress(a); // drop the stale DENIED so a subsequent screen re-evaluates against the vendor
  return { ok: true };
}
function onDenylist(address: string): boolean {
  return loadDeny().addresses.includes(address.toLowerCase());
}

/**
 * Merit's OWN authoritative refusals — the hard floor beneath any vendor. A structurally-bad address or an
 * operator-denylisted one is DENIED regardless of what Circle returns (a vendor APPROVED must never override the
 * operator's own denylist). Returns the DENIED result, or null when Merit has no floor-level objection. The
 * documented test-suffixes are deliberately NOT here — they are a fallback-only demo vector (localScreen), never
 * allowed to masquerade as authoritative over a live vendor answer.
 */
function hardFloor(raw: string): ScreenResult | null {
  const now = new Date().toISOString();
  const chain = screenChain();
  const base = { source: "local" as const, chain, screenedAt: now, cleared: false };
  if (!isHexAddress(raw)) {
    return { ...base, address: raw, decision: "DENIED", ruleName: "malformed address", riskScore: "INVALID", riskCategories: ["MALFORMED"], actions: [], basis: "not a valid 0x address — refused (never settle to an unparseable payee)", reason: "malformed payee address" };
  }
  const address = getAddress(raw);
  if (/^0x0{40}$/i.test(raw)) {
    return { ...base, address, decision: "DENIED", ruleName: "zero address", riskScore: "INVALID", riskCategories: ["ZERO_ADDRESS"], actions: [], basis: "the zero address is never a valid payee", reason: "zero address" };
  }
  if (onDenylist(address)) {
    return { ...base, address, decision: "DENIED", ruleName: "Operator Denylist", riskScore: "BLOCKLIST", riskCategories: ["CUSTOM"], actions: ["DENY"], basis: "operator-maintained denylist (authoritative — overrides a vendor approval)", reason: "address is on the operator denylist" };
  }
  return null;
}

// Circle's documented testnet address-suffix test vectors (tx-screening-testing). Recognized so the pre-gate is
// demonstrable + testable WITHOUT Compliance-Engine entitlement — labelled source:"local", basis:"circle-test-suffix"
// so it is never confused with a real vendor finding.
const TEST_SUFFIXES: Record<string, { decision: Decision; risk: string; categories: string[]; label: string }> = {
  "9999": { decision: "DENIED", risk: "BLOCKLIST", categories: ["SANCTIONS"], label: "Circle's Sanctions Blocklist" },
  "7777": { decision: "DENIED", risk: "BLOCKLIST", categories: ["CUSTOM"], label: "Your Blocklist" },
  "8999": { decision: "DENIED", risk: "SEVERE", categories: ["SANCTIONS"], label: "Severe Sanctions Risk (Owner)" },
  "8899": { decision: "DENIED", risk: "SEVERE", categories: ["TERRORIST_FINANCING"], label: "Severe Terrorist Financing (Owner)" },
  "8889": { decision: "DENIED", risk: "SEVERE", categories: ["CSAM"], label: "Severe CSAM Risk (Owner)" },
  "7779": { decision: "DENIED", risk: "SEVERE", categories: ["ILLICIT_BEHAVIOR"], label: "Severe Illicit Behavior (Owner)" },
  "8888": { decision: "REVIEW", risk: "FROZEN", categories: ["FROZEN"], label: "Frozen User Wallet" },
  "7666": { decision: "REVIEW", risk: "HIGH", categories: ["ILLICIT_BEHAVIOR"], label: "High Illicit Behavior Risk (Owner)" },
  "7766": { decision: "REVIEW", risk: "HIGH", categories: ["GAMBLING"], label: "High Gambling Risk (Owner)" },
};

/**
 * Deterministic local screen (no network) — always decides. Malformed/zero address → DENIED (never pay a bad
 * address); operator denylist → DENIED; Circle's documented test suffix → its mapped decision; otherwise APPROVED
 * with `cleared:false` and an explicit basis that it is "no rule matched locally," NOT a sanctions clearance.
 */
export function localScreen(addressRaw: string): ScreenResult {
  const now = new Date().toISOString();
  const chain = screenChain();
  const base = { source: "local" as const, chain, screenedAt: now, actions: [] as string[] };
  const raw = (addressRaw || "").trim();
  if (!isHexAddress(raw)) {
    return { ...base, address: raw, decision: "DENIED", cleared: false, ruleName: "malformed address", riskScore: "INVALID", riskCategories: ["MALFORMED"], basis: "not a valid 0x address — refused (never settle to an unparseable payee)", reason: "malformed payee address" };
  }
  const address = getAddress(raw);
  if (/^0x0{40}$/i.test(raw)) {
    return { ...base, address, decision: "DENIED", cleared: false, ruleName: "zero address", riskScore: "INVALID", riskCategories: ["ZERO_ADDRESS"], basis: "the zero address is never a valid payee", reason: "zero address" };
  }
  if (onDenylist(address)) {
    return { ...base, address, decision: "DENIED", cleared: false, ruleName: "Operator Denylist", riskScore: "BLOCKLIST", riskCategories: ["CUSTOM"], actions: ["DENY"], basis: "operator-maintained denylist", reason: "address is on the operator denylist" };
  }
  const suffix = raw.slice(-4).toLowerCase();
  const t = TEST_SUFFIXES[suffix];
  if (t) {
    return { ...base, address, decision: t.decision, cleared: false, ruleName: t.label, riskScore: t.risk, riskCategories: t.categories, actions: t.decision === "DENIED" ? ["DENY", "REVIEW"] : ["REVIEW"], basis: "circle-test-suffix (documented testnet vector — not a live vendor finding)", reason: `${t.label} (${t.decision})` };
  }
  return { ...base, address, decision: "APPROVED", cleared: false, ruleName: null, riskScore: "LOW", riskCategories: [], basis: "no local rule matched — NOT a sanctions clearance; configure Circle Compliance Engine for authoritative screening", reason: "no local rule matched (unscreened by a vendor)" };
}

/** Map a Circle screening API response body to a ScreenResult (pure — unit-tested against the documented shape). */
export function mapCircleResponse(address: string, chain: string, body: unknown): ScreenResult {
  const b = (body || {}) as { result?: string; decision?: { ruleName?: string; actions?: string[]; reasons?: Array<{ riskScore?: string; riskCategories?: string[] }> } };
  const result = (b.result || "").toUpperCase();
  const dec = b.decision || {};
  const actions = Array.isArray(dec.actions) ? dec.actions.map((a) => String(a).toUpperCase()) : [];
  const reason0 = dec.reasons?.[0] || {};
  // Fail-safe mapping (the dangerous direction is a false APPROVED). DENIED only lets money NOT move, so map any
  // block signal to DENIED (explicit DENIED result, or a DENY / FREEZE_WALLET action — a frozen recipient must
  // not receive). APPROVED / cleared ONLY on an EXPLICIT result:"APPROVED" with no REVIEW action — never as a
  // catch-all. Anything else (missing/unknown/PENDING result, empty body, REVIEW action) is REVIEW, never a
  // clearance, so an unexpected shape can't silently clear a sanctioned payout.
  const denied = result === "DENIED" || actions.includes("DENY") || actions.includes("FREEZE_WALLET");
  const approved = result === "APPROVED" && !actions.includes("REVIEW");
  const decision: Decision = denied ? "DENIED" : approved ? "APPROVED" : "REVIEW";
  return {
    address,
    decision,
    cleared: decision === "APPROVED", // reached only via an explicit result:"APPROVED" — a real vendor clearance
    ruleName: dec.ruleName || null,
    riskScore: reason0.riskScore || (decision === "APPROVED" ? "LOW" : null),
    riskCategories: Array.isArray(reason0.riskCategories) ? reason0.riskCategories : [],
    actions,
    source: "circle",
    basis: dec.ruleName ? `Circle Compliance Engine rule: ${dec.ruleName}` : `Circle Compliance Engine (result: ${result || "unspecified"})`,
    chain,
    screenedAt: new Date().toISOString(),
    reason: decision === "APPROVED" ? "Circle Compliance Engine: approved" : `Circle Compliance Engine: ${decision}${dec.ruleName ? ` (${dec.ruleName})` : ""}`,
  };
}

// ---- the screen (Circle when entitled, local fallback) --------------------------------------------------

// Bounded LRU-ish cache of the VENDOR/heuristic layer (never the hard floor). Keyed by (config-generation, chain,
// address) so enabling/disabling Circle or changing the chain invalidates stale entries instead of serving a local
// APPROVED as if it were a vendor answer (M4). Size-capped so a stream of distinct addresses can't grow it forever.
const cache = new Map<string, { at: number; res: ScreenResult }>();
const CACHE_TTL = Number(process.env.MERIT_COMPLIANCE_CACHE_TTL_MS) || 10 * 60_000;
const CACHE_MAX = Number(process.env.MERIT_COMPLIANCE_CACHE_MAX) || 5000;
function cacheKey(addressLower: string): string {
  return `${complianceConfigured() ? "c" : "l"}|${screenChain()}|${addressLower}`;
}
function cacheSet(key: string, res: ScreenResult): void {
  cache.set(key, { at: Date.now(), res });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value; // Map preserves insertion order → evict the oldest
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// A degraded screen: Circle was CONFIGURED (the operator wants vendor screening) but the call did not return a
// clean answer (outage / 429 / bad body). We must NOT silently degrade to an allowed APPROVED (fail-open is the
// worst outcome for a compliance gate) — return REVIEW so it is surfaced, and a strict deployment blocks it.
function degradedResult(address: string): ScreenResult {
  return {
    address,
    decision: "REVIEW",
    cleared: false,
    ruleName: "vendor unavailable",
    riskScore: null,
    riskCategories: ["VENDOR_UNAVAILABLE"],
    actions: ["REVIEW"],
    source: "local",
    basis: "Circle Compliance Engine was configured but did not return a clean answer — degraded to REVIEW (not a clearance); set MERIT_COMPLIANCE_STRICT=1 to block on vendor unavailability",
    chain: screenChain(),
    screenedAt: new Date().toISOString(),
    reason: "compliance vendor unavailable — flagged for review, not cleared",
  };
}

/**
 * Screen a payee address. Tries the live Circle Compliance Engine when configured+entitled; on no-key / any error
 * / not-entitled it degrades to the deterministic local screen (honestly labelled). Result is signed + cached +
 * logged. `sign:false` for tests. Never throws.
 */
export async function screenAddress(addressRaw: string, opts: { sign?: boolean; noCache?: boolean } = {}): Promise<ScreenResult> {
  const raw = (addressRaw || "").trim();
  const key = cacheKey(raw.toLowerCase());

  // Merit's authoritative floor is checked FIRST and is NEVER cache-served — it is cheap (no network) and must
  // always reflect the CURRENT operator denylist, so a just-denylisted address is blocked immediately (not after
  // the cache TTL). Only when Merit has no floor objection do we consult the (cacheable) vendor/heuristic layer.
  let res = hardFloor(raw);
  let cacheable = false;
  if (!res) {
    if (!opts.noCache) {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL) return hit.res;
      if (hit) cache.delete(key); // expired — evict rather than let it linger (M1)
    }
    if (complianceConfigured()) {
      // Circle is configured, so the operator WANTS vendor screening. A clean answer is used; a failure degrades
      // to REVIEW (C1 — never a silent allowed APPROVED), and under strict posture a vendor failure BLOCKS.
      const vendor = await circleScreen(raw).catch(() => null);
      if (vendor) {
        res = vendor;
      } else {
        res = degradedResult(raw);
        if (process.env.MERIT_COMPLIANCE_STRICT === "1") {
          res.decision = "DENIED";
          res.actions = ["DENY", "REVIEW"];
          res.basis = "Circle Compliance Engine unavailable and MERIT_COMPLIANCE_STRICT=1 — blocked (fail-closed)";
          res.reason = "compliance vendor unavailable — blocked (strict mode)";
        }
        cacheable = false; // never cache a transient vendor-unavailable verdict — retry the vendor next time
      }
    } else {
      // No key / disabled — the local heuristic screen is the legitimate permanent fallback for an un-entitled
      // deployment (its APPROVED is honestly "no rule matched", NOT a clearance).
      res = localScreen(raw);
      cacheable = true;
    }
    if (res && res.source === "circle") cacheable = true;
  }

  if (opts.sign !== false) {
    try {
      const sig = await signReceipt(res);
      if (sig) Object.assign(res, sig);
    } catch {
      /* signing is best-effort — an unsigned decision is still a valid, checkable record */
    }
  }
  res.screeningId = verificationId({ address: res.address, decision: res.decision, source: res.source, ruleName: res.ruleName, riskScore: res.riskScore, screenedAt: res.screenedAt });
  if (cacheable && !opts.noCache) cacheSet(key, res);
  recordScreen(res);
  return res;
}

async function circleScreen(address: string): Promise<ScreenResult | null> {
  const chain = screenChain();
  const url = process.env.MERIT_COMPLIANCE_URL || CIRCLE_SCREEN_URL; // override for self-hosted proxy / testing
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCREEN_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), address, chain }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null; // not entitled / bad key / rate-limited → caller falls back to the local screen
    const data = await res.json();
    // Circle wraps the screening body under `data` on the w3s APIs; accept either shape.
    return mapCircleResponse(address, chain, data?.data ?? data);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The settlement precondition: is it permitted to move USDC to this payee? DENIED blocks; REVIEW is allowed by
 * default (surfaced for manual attention) unless MERIT_COMPLIANCE_BLOCK_REVIEW=1 (strict enterprise posture).
 * Returns the full screen so a caller can log the exact reason. Fails OPEN only on the local "no rule matched"
 * APPROVED (so an un-entitled deployment still settles) — a DENIED (from any source) always blocks.
 */
export async function assertPayeeCompliant(address: string): Promise<{ allowed: boolean; screen: ScreenResult }> {
  const screen = await screenAddress(address);
  const blockReview = process.env.MERIT_COMPLIANCE_BLOCK_REVIEW === "1";
  const allowed = screen.decision === "DENIED" ? false : screen.decision === "REVIEW" ? !blockReview : true;
  return { allowed, screen };
}

// ---- screening log (append-only, mirrored) --------------------------------------------------------------

export interface ScreenLogEntry {
  at: string;
  address: string;
  decision: Decision;
  source: "circle" | "local";
  riskScore: string | null;
  ruleName: string | null;
  screeningId: `0x${string}` | null;
}
interface ScreenLog { screens: ScreenLogEntry[] }
const LOG_DOC = "compliance";
const MAX_LOG = 20_000;
let logCache: ScreenLog | null = null;
function loadLog(): ScreenLog {
  if (logCache) return logCache;
  const { value, cacheable } = loadDocFresh<ScreenLog>(LOG_DOC, { screens: [] });
  if (!Array.isArray(value.screens)) value.screens = [];
  if (cacheable) logCache = value;
  return value;
}
function recordScreen(r: ScreenResult): void {
  const log = loadLog();
  log.screens.push({ at: r.screenedAt, address: r.address, decision: r.decision, source: r.source, riskScore: r.riskScore, ruleName: r.ruleName, screeningId: r.screeningId || null });
  if (log.screens.length > MAX_LOG) log.screens = log.screens.slice(-MAX_LOG);
  logCache = log;
  saveDoc(LOG_DOC, log);
}
export async function refreshComplianceFromMirror(): Promise<void> {
  const [l, d] = await Promise.all([loadDocFromMirror<ScreenLog>(LOG_DOC), loadDocFromMirror<Denylist>(DENY_DOC)]);
  if (l && Array.isArray(l.screens)) logCache = l;
  if (d && Array.isArray(d.addresses)) denyCache = d;
}
export function complianceStats(): { screens: number; approved: number; review: number; denied: number; viaCircle: number; denylistSize: number } {
  const s = loadLog().screens;
  let approved = 0, review = 0, denied = 0, viaCircle = 0;
  for (const x of s) {
    if (x.decision === "APPROVED") approved++;
    else if (x.decision === "REVIEW") review++;
    else denied++;
    if (x.source === "circle") viaCircle++;
  }
  return { screens: s.length, approved, review, denied, viaCircle, denylistSize: loadDeny().addresses.length };
}
export function recentScreens(limit = 20): ScreenLogEntry[] {
  const s = loadLog().screens;
  return s.slice(Math.max(0, s.length - limit)).reverse();
}

/** Test seam. */
export function _resetCompliance(): void {
  cache.clear();
  denyCache = null;
  logCache = null;
}

/**
 * Endpoint scorecards (Hub feature #1) — Merit's public "verified-quality score for ANY x402 endpoint".
 *
 * Every buyer/reputation project in the agentic economy scores the sellers it uses — but on price, latency,
 * uptime, or a submitted star rating, because those are the only signals a payment rail can see. Merit scores
 * the one dimension none of them can produce: **does what the endpoint actually SELLS verify?** Point Merit at
 * any URL with a claim it should back; Merit pays the toll (if any, budget-capped), takes the delivered content,
 * runs it through the real three-gate proof-of-citation verifier, and publishes a signed, shareable scorecard +
 * a verified-quality-per-dollar leaderboard. This turns every other agent endpoint into a live, verifiable data
 * point — the reciprocal-scoring loop the whole field runs, but settled on correctness instead of reputation.
 *
 * Honesty invariants (load-bearing — a fabricated score would poison the leaderboard):
 *   - `paid`/`paidUsdc`/`tx` reflect a REAL settlement only. If Merit can't or doesn't pay, paid=false, paidUsdc=0.
 *   - `verifiable:false` (with a reason) when no content could be retrieved to verify — NEVER a made-up verdict.
 *   - `valuePerDollar` is set only when a nonzero toll was actually paid (quality-per-free is meaningless).
 * Store-backed (+ Supabase mirror); holds no private keys.
 */
import { randomBytes } from "node:crypto";
import { assertPublicUrl, guardedFetch } from "./ssrf";
import { supportsPayment, payAndFetch, type PaymentSupport } from "./pay";
import { verifyCitation, isVerifyError, type GateBreakdown } from "./verify/engine";
import { round6 } from "./arc";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

export interface Scorecard {
  id: string;
  url: string;
  host: string;
  claim: string;
  reachable: boolean;
  status: number | null;
  tollPresent: boolean; // the endpoint answered with an x402 payment challenge
  priceUsdc: number | null; // the toll it asked for (parsed from the challenge), if any
  network: string | null;
  paid: boolean; // Merit actually settled the toll (real money moved)
  paidUsdc: number; // USDC really paid (0 when free or unpaid)
  tx: string | null;
  explorerUrl: string | null;
  verifiable: boolean; // Merit obtained content it could check against the claim
  verdict: "SUPPORTED" | "REFUSED" | null;
  quality: number | null; // 0..1 verified-quality of the delivered content
  valuePerDollar: number | null; // quality / paidUsdc — set ONLY when a nonzero toll was paid
  methods: string[];
  gates?: GateBreakdown;
  verificationId?: string;
  reason: string; // honest, human-readable outcome (incl. why an endpoint was terms-only / unpaid)
  createdAt: string;
}

/** One row of the public leaderboard — a host's aggregate across every scorecard Merit has produced for it. */
export interface LeaderboardRow {
  host: string;
  scored: number;
  verified: number; // how many scorecards came back SUPPORTED
  avgQuality: number; // mean verified-quality over the scorecards that were verifiable
  bestValuePerDollar: number | null; // best verified-quality-per-dollar seen (paid scorecards only)
  paidScorecards: number; // how many involved a real settlement
  lastAt: string;
  sampleUrl: string;
}

interface ScorecardLog {
  entries: Scorecard[];
}

const DOC = "scorecards";
const MAX_SCORECARDS = 2000;
const MAX_CONTENT = 20000; // matches the verify engine's source cap
const FETCH_TIMEOUT_MS = 15000;

let cache: ScorecardLog | null = null;
function load(): ScorecardLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<ScorecardLog>(DOC, { entries: [] });
  if (!value.entries) value.entries = [];
  if (cacheable) cache = value;
  return value;
}

/** Read-your-writes refresh from the durable mirror before a list/leaderboard read on serverless (a warm
 *  instance would otherwise miss scorecards written on another instance). No-op off the Supabase mirror. */
export async function refreshScorecardsFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<ScorecardLog>(DOC);
  if (v && Array.isArray(v.entries)) cache = v;
}

function newId(): string {
  return BigInt("0x" + randomBytes(8).toString("hex")).toString(36).slice(0, 11);
}

/** Persist a scorecard (append, cap, mirror). Best-effort; never throws into a caller. */
export function saveScorecard(sc: Scorecard): Scorecard {
  try {
    const log = load();
    log.entries.push(sc);
    if (log.entries.length > MAX_SCORECARDS) log.entries = log.entries.slice(-MAX_SCORECARDS);
    cache = log;
    saveDoc(DOC, log);
  } catch (e) {
    console.error("[scorecard] save failed:", (e as Error).message);
  }
  return sc;
}

export function getScorecard(id: string): Scorecard | undefined {
  if (!id) return undefined;
  return load().entries.find((s) => s.id === id);
}

export function listScorecards(limit = 30): Scorecard[] {
  const e = load().entries;
  return e.slice(Math.max(0, e.length - limit)).reverse();
}

export function scorecardCount(): number {
  return load().entries.length;
}

/** Aggregate every scorecard by host into the ranked leaderboard (best verified-quality first). Pure over the
 *  current log — the "who sells content that actually verifies" board a price/uptime directory can't build. */
export function leaderboard(): LeaderboardRow[] {
  const byHost = new Map<string, Scorecard[]>();
  for (const s of load().entries) {
    if (!s.host) continue;
    (byHost.get(s.host) ?? byHost.set(s.host, []).get(s.host)!).push(s);
  }
  const rows: LeaderboardRow[] = [];
  for (const [host, cards] of byHost) {
    const verifiable = cards.filter((c) => c.verifiable && c.quality !== null);
    const paid = cards.filter((c) => c.paid);
    const vpd = cards.map((c) => c.valuePerDollar).filter((v): v is number => v !== null);
    rows.push({
      host,
      scored: cards.length,
      verified: cards.filter((c) => c.verdict === "SUPPORTED").length,
      avgQuality: verifiable.length ? round6(verifiable.reduce((a, c) => a + (c.quality as number), 0) / verifiable.length) : 0,
      bestValuePerDollar: vpd.length ? round6(Math.max(...vpd)) : null,
      paidScorecards: paid.length,
      lastAt: cards.reduce((a, c) => (c.createdAt > a ? c.createdAt : a), cards[0].createdAt),
      sampleUrl: cards[cards.length - 1].url,
    });
  }
  return rows.sort((a, b) => b.avgQuality - a.avgQuality || b.verified - a.verified);
}

/** Map a citation verdict to a 0..1 verified-quality. Uses the NLI support probability when the engine produced
 *  one; otherwise a decisive-but-not-absolute prior for a bare SUPPORTED/REFUSED (a keyless numeric-only refuse). */
function qualityFromVerdict(verdict: "SUPPORTED" | "REFUSED", score: number | null): number {
  if (score !== null) return round6(Math.max(0, Math.min(1, score)));
  return verdict === "SUPPORTED" ? 0.9 : 0.05;
}

/** Pull the verifiable text out of whatever an endpoint returned — a raw string, or the usual answer-bearing
 *  fields of a JSON response, falling back to the serialized object. Capped to the engine's source limit. */
function extractDeliverable(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return data.slice(0, MAX_CONTENT);
  if (typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const k of ["answer", "content", "text", "output", "result", "summary", "message", "body", "data"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.slice(0, MAX_CONTENT);
    }
    try {
      return JSON.stringify(data).slice(0, MAX_CONTENT);
    } catch {
      return String(data).slice(0, MAX_CONTENT);
    }
  }
  return String(data).slice(0, MAX_CONTENT);
}

export interface ScoreOptions {
  url: string;
  claim: string;
  /** Max USDC Merit may spend to settle a toll before scoring. 0 (default) = probe/verify only, never pay. */
  maxPriceUsdc?: number;
  /** Whether real payment is permitted at all (route sets this true only for an authenticated principal). */
  allowPay?: boolean;
}

/**
 * Score one endpoint end-to-end: reach it, read its toll terms, optionally pay (budget-capped), verify the
 * delivered content against the claim, and assemble a signed, shareable scorecard. Never throws — every failure
 * mode (unreachable, toll-we-couldn't-pay, no content, no model) becomes an honest card with `reachable`/
 * `verifiable` flags and a reason, so the leaderboard only ever contains truthful outcomes.
 */
export async function scoreEndpoint(opts: ScoreOptions): Promise<Scorecard> {
  const url = (opts.url || "").trim();
  const claim = (opts.claim || "").trim();
  const maxPrice = Math.max(0, Number(opts.maxPriceUsdc) || 0);
  const allowPay = !!opts.allowPay && maxPrice > 0;
  const createdAt = new Date().toISOString();

  const base: Scorecard = {
    id: newId(),
    url,
    host: "",
    claim,
    reachable: false,
    status: null,
    tollPresent: false,
    priceUsdc: null,
    network: null,
    paid: false,
    paidUsdc: 0,
    tx: null,
    explorerUrl: null,
    verifiable: false,
    verdict: null,
    quality: null,
    valuePerDollar: null,
    methods: [],
    reason: "",
    createdAt,
  };

  // SSRF-safe URL validation up front — a private/loopback/malformed target is rejected without a fetch.
  let parsed: URL;
  try {
    parsed = await assertPublicUrl(url);
  } catch (e) {
    return { ...base, reason: `unreachable: ${(e as Error).message}` };
  }
  base.host = parsed.host;

  // Probe reachability + free content with a single SSRF-pinned GET.
  let content = "";
  let probe: PaymentSupport | null = null;
  try {
    const res = await guardedFetch(url, {
      method: "GET",
      headers: { "User-Agent": "MeritEndpointScorer/1 (+https://onmerit.xyz)", Accept: "application/json, text/plain, */*" },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    base.reachable = true;
    base.status = res.status;

    if (res.status === 402) {
      // Toll-gated. Read the terms (price/network) via the Gateway probe, and pay only if allowed + affordable.
      base.tollPresent = true;
      probe = await supportsPayment(url);
      base.priceUsdc = probe.priceUsdc;
      base.network = probe.network;
      if (allowPay && probe.supported && (probe.priceUsdc === null || probe.priceUsdc <= maxPrice + 1e-9)) {
        try {
          const paidRes = await payAndFetch(url, maxPrice);
          base.paid = true;
          base.paidUsdc = paidRes.amount;
          base.tx = paidRes.transaction;
          base.explorerUrl = paidRes.explorerUrl || null;
          content = extractDeliverable(paidRes.data);
        } catch (e) {
          base.reason = `toll present (${base.priceUsdc ?? "?"} USDC${base.network ? " on " + base.network : ""}) — payment not completed: ${(e as Error).message}`;
        }
      } else {
        // Didn't pay (not permitted, unsupported scheme, or over budget). Some endpoints still return a
        // preview body alongside the 402 — verify that if present; otherwise this is honestly terms-only.
        content = extractDeliverable(await res.text().catch(() => ""));
        if (!base.reason) {
          base.reason = probe.supported
            ? `toll present (${base.priceUsdc ?? "?"} USDC) — not paid (${allowPay ? "over the authorized ceiling" : "scored in probe-only mode; supply an API key + maxPrice to pay and verify the paid content"})`
            : `toll present but Merit can't settle its scheme (${probe.error || "unsupported"}) — scored on any preview content only`;
        }
      }
    } else if (res.ok) {
      content = extractDeliverable(await res.text().catch(() => ""));
    } else {
      base.reason = `endpoint returned HTTP ${res.status} — no content to verify`;
    }
  } catch (e) {
    return { ...base, reason: `unreachable: ${(e as Error).message}` };
  }

  // Nothing to verify (paywalled with no preview, empty body, or an error status) — honest terms-only card.
  if (!content.trim()) {
    if (!base.reason) base.reason = "the endpoint returned no readable content to verify against the claim";
    return saveScorecard(base);
  }

  // The moat: verify what the endpoint actually delivered against the claim it was asked to back.
  const outcome = await verifyCitation(claim, content, {});
  if (isVerifyError(outcome)) {
    base.reason = `retrieved ${content.length} chars but could not verify: ${outcome.error}`;
    return saveScorecard(base);
  }
  const v = outcome.verdict;
  base.verifiable = true;
  base.verdict = v.verdict;
  base.quality = qualityFromVerdict(v.verdict, v.score);
  base.methods = v.methods;
  base.gates = v.gates;
  base.verificationId = v.verificationId;
  base.valuePerDollar = base.paid && base.paidUsdc > 0 ? round6(base.quality / base.paidUsdc) : null;
  base.reason =
    v.verdict === "SUPPORTED"
      ? `Merit ${base.paid ? `paid ${base.paidUsdc} USDC and ` : ""}verified the delivered content — it SUPPORTS the claim (quality ${base.quality}${base.valuePerDollar !== null ? `, ${base.valuePerDollar} verified-quality per $` : ""}).`
      : `Merit ${base.paid ? `paid ${base.paidUsdc} USDC and ` : ""}verified the delivered content — it does NOT support the claim (REFUSED). ${base.paid ? "A pay-on-delivery rail would have paid for content that doesn't verify; Merit surfaces it." : ""}`.trim();

  return saveScorecard(base);
}

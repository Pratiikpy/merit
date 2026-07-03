/**
 * Verified procurement (Wave C #9) — "verify the work, not just pay for it," applied to Merit's OUTBOUND buys.
 * Given a source Merit procured (a URL to fetch, or content already delivered) and the CLAIM it was procured for,
 * Merit runs the CVO to check the delivered content actually SUPPORTS that claim, records the seller's outcome
 * (feeding the reputation firewall, lib/sellers), and returns the verdict. A seller that has already been
 * firewalled is refused BEFORE any fetch/pay. This turns an external purchase from "pay and hope" into "pay only
 * for delivery that verifies" — the moat, pointed outward.
 */
import { isVerifyError, verifyCitation, type Verdict } from "./verify/engine";
import { verifyWithCache, refreshVcacheFromMirror } from "./vcache";
import { extractSourceFromUrl } from "./extract";
import { recordDelivery, refreshSellersFromMirror, sellerBlocked, sellerHost, sellerScore } from "./sellers";

export interface ProcureResult {
  ok: true;
  host: string;
  verified: boolean;
  verdict: "SUPPORTED" | "REFUSED";
  reason: string;
  gates: unknown;
  contentPreview: string;
  sellerScore: number;
  cached: boolean;
  content: string; // the delivered content (for the caller to mint a receipt card)
  verdictObj: Verdict; // the full signed verdict
}
export interface ProcureError {
  ok: false;
  error: string;
  status: number;
  host?: string;
  blocked?: boolean;
}

/**
 * Procure + verify. `content` (already delivered) takes precedence; otherwise the URL is fetched SSRF-safely.
 * `record` (default true) gates whether the outcome moves the seller's REPUTATION: an accountable, keyed
 * procurement records; an anonymous public probe verifies but does NOT touch reputation, so no one can tank a
 * seller's standing with unauthenticated, mismatched-claim requests.
 */
export async function procure(input: { url?: string; content?: string; claim: string; record?: boolean }): Promise<ProcureResult | ProcureError> {
  const claim = (input.claim || "").trim();
  if (!claim) return { ok: false, error: "provide the { claim } this was procured for", status: 400 };
  const url = (input.url || "").trim();
  const urlHost = sellerHost(url || "provided-content");

  // Get the delivered content. If Merit FETCHES it from the URL, the outcome counts against THAT host's
  // reputation — and a firewalled seller is refused before any fetch. If the caller supplies `content` directly,
  // Merit didn't fetch it from the named host, so the outcome must NOT be attributed to that host (else anyone
  // could tank a legitimate seller by posting junk with its URL) — it goes to a separate `provided:` bucket.
  let content = (input.content || "").trim();
  let fetched = false;
  if (!content) {
    if (!url) return { ok: false, error: "provide a { url } to fetch or { content } that was delivered", status: 400, host: urlHost };
    await refreshSellersFromMirror().catch(() => {});
    const fw = sellerBlocked(urlHost);
    if (fw.blocked) return { ok: false, error: `this seller is firewalled — ${fw.reason}`, status: 403, host: urlHost, blocked: true };
    const ex = await extractSourceFromUrl(url);
    if (!ex.ok) return { ok: false, error: ex.error, status: 400, host: urlHost };
    content = ex.text;
    fetched = true;
  }
  const host = fetched ? urlHost : `provided:${urlHost}`;

  // Verify the delivered content supports the claim it was procured for.
  await refreshVcacheFromMirror().catch(() => {});
  const { outcome, cached } = await verifyWithCache(claim, content, () => verifyCitation(claim, content));
  if (isVerifyError(outcome)) return { ok: false, error: outcome.error, status: outcome.status, host };
  const v = outcome.verdict;
  const verified = v.verdict === "SUPPORTED";

  // Record the delivery — a FETCHED delivery moves the real seller's reputation (what firewalls a junk seller);
  // provided content is recorded only under its isolated bucket. Only when `record` (an accountable, keyed
  // procurement) — an anonymous probe never moves reputation.
  if (input.record !== false) recordDelivery(host, verified);

  return {
    ok: true,
    host,
    verified,
    verdict: v.verdict,
    reason: v.reason,
    gates: v.gates,
    contentPreview: content.slice(0, 400),
    sellerScore: Math.round(sellerScore(host) * 1000) / 1000,
    cached,
    content,
    verdictObj: v,
  };
}

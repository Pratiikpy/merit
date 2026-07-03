/**
 * External-seller reputation (Wave C #9/#10) — "verify the work, not the worker," applied to Merit's OUTBOUND
 * purchases. When Merit procures from an external source/seller (a data API, a page, another agent), it verifies
 * that what was delivered actually supports the claim it was procured for, and records the outcome PER HOST here.
 * A seller that keeps delivering verifiable content earns trust; one that delivers unsupported junk sinks and is
 * eventually FIREWALLED (C10) — Merit stops paying it. The score is a Beta-Bernoulli posterior of the seller's
 * verified-delivery rate, so a never-seen seller starts neutral and converges with evidence. Store-backed
 * (+ mirror); host-keyed; holds no keys.
 */
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

export interface SellerRep {
  host: string;
  procured: number; // total deliveries verified-or-not
  verified: number; // deliveries whose content SUPPORTED the claim
  refuted: number; // deliveries whose content did NOT support the claim
  lastAt: string;
  blockedManually?: boolean; // an operator hard-block, independent of the score
}
interface SellerLog {
  sellers: Record<string, SellerRep>;
}

const DOC = "sellers";
const MIN_SAMPLES = 4; // don't firewall a seller until there's enough evidence

function blockThreshold(): number {
  const v = Number(process.env.MERIT_SELLER_BLOCK_BELOW);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.34; // block when the verified-delivery rate drops below this
}

let cache: SellerLog | null = null;
function load(): SellerLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<SellerLog>(DOC, { sellers: {} });
  if (!value.sellers) value.sellers = {};
  if (cacheable) cache = value;
  return value;
}
export async function refreshSellersFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<SellerLog>(DOC);
  if (v && typeof v === "object") {
    if (!v.sellers) v.sellers = {};
    cache = v;
  }
}
function persist(): void {
  if (cache) saveDoc(DOC, cache);
}

/** Normalize a URL (or host) to a lowercase host key. */
export function sellerHost(urlOrHost: string): string {
  try {
    return new URL(urlOrHost).hostname.toLowerCase();
  } catch {
    return (urlOrHost || "").replace(/^https?:\/\//i, "").split("/")[0].toLowerCase().trim();
  }
}

function ent(host: string): SellerRep {
  const log = load();
  cache = log; // pin the loaded log AS the cache so a mutation below is what persist() saves (never dropped on
  // an ephemeral, non-cacheable read — the previous `cache = load()` re-read a fresh doc and lost the write)
  return (log.sellers[host] ||= { host, procured: 0, verified: 0, refuted: 0, lastAt: "" });
}

/** Record a delivery outcome for a seller (verified = its content supported the procured claim). */
export function recordDelivery(host: string, verified: boolean): void {
  if (!host) return;
  const e = ent(host);
  e.procured += 1;
  if (verified) e.verified += 1;
  else e.refuted += 1;
  e.lastAt = new Date().toISOString();
  persist();
}

/** Beta-Bernoulli posterior mean of a seller's verified-delivery rate (0.5 = unseen/neutral). */
export function sellerScore(host: string): number {
  const e = load().sellers[host];
  if (!e) return 0.5;
  return (e.verified + 1) / (e.procured + 2);
}

/** Should Merit REFUSE to procure/pay this seller? True on an operator block, or once enough evidence shows the
 *  verified-delivery rate has collapsed below the threshold. Fewer than MIN_SAMPLES → never blocked (give it a chance). */
export function sellerBlocked(host: string): { blocked: boolean; reason?: string } {
  const e = load().sellers[host];
  if (!e) return { blocked: false };
  if (e.blockedManually) return { blocked: true, reason: "operator-blocked seller" };
  if (e.procured >= MIN_SAMPLES && sellerScore(host) < blockThreshold()) {
    return { blocked: true, reason: `seller verified-delivery rate ${Math.round(sellerScore(host) * 100)}% below the ${Math.round(blockThreshold() * 100)}% bar over ${e.procured} deliveries` };
  }
  return { blocked: false };
}

export function setSellerBlock(host: string, blocked: boolean): void {
  const e = ent(host);
  e.blockedManually = blocked || undefined;
  e.lastAt = new Date().toISOString();
  persist();
}

export function sellersList(): Array<SellerRep & { score: number; blocked: boolean }> {
  return Object.values(load().sellers)
    .map((s) => ({ ...s, score: Math.round(sellerScore(s.host) * 1000) / 1000, blocked: sellerBlocked(s.host).blocked }))
    .sort((a, b) => b.procured - a.procured);
}

/** Test seam. */
export function _resetSellers(): void {
  cache = null;
}

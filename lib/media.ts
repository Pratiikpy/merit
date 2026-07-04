/**
 * Provenance-verified media licensing (Hub feature #6) — extends the proof-of-citation moat to a new modality.
 *
 * The media/clip marketplaces in the field (Findling, nano-VOD, CastPay) settle on ownership + a payment, but
 * never check that the clip is actually WHAT IT CLAIMS TO BE. Merit does: a seller lists media with a title,
 * description, and transcript; a buyer (human or agent) requests media for a specific need; before any USDC
 * moves, Merit's three-gate verifier checks that the media's own description + transcript genuinely SUPPORT the
 * request — the same faithfulness check that gates a citation, applied to provenance. You never license a clip
 * that isn't what it says. A verified license is a signed merit.license/v1 certificate; the owner is paid
 * (claimable custody, compliance-screened, proven on-chain by the hook when enabled) only on a real match.
 *
 * Note on modality: the description/transcript IS the provenance signal here (the fraud vector is a clip
 * mislabeled to match a query). A vision/audio captioner is a drop-in upgrade — swap the verified source from
 * the stored transcript to a model-generated caption; the gate, receipt, and settlement are unchanged.
 * Honesty: a payout accrues only on a genuine verified match; on-chain links only when a tx lands.
 */
import { randomBytes } from "node:crypto";
import { keccak256, toHex } from "viem";
import { round6 } from "./arc";
import { verifyCitation, isVerifyError } from "./verify/engine";
import { signReceipt, verificationId } from "./receipt";
import { accrueCustody, refreshCustodyFromMirror } from "./custody";
import { assertPayeeCompliant } from "./compliance";
import { settleViaHook, jobHookEnabled } from "./job";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

export type MediaType = "image" | "video" | "audio" | "other";

export interface MediaItem {
  id: string;
  title: string;
  description: string;
  transcript?: string; // for video/audio (or extended caption) — part of the verified provenance source
  url?: string;
  mediaType: MediaType;
  owner: string;
  ownerAddress?: string;
  priceUsdc: number;
  attestation?: string; // the owner's stated ownership/rights claim (shown on the license; not itself a gate)
  createdAt: string;
}

export interface MediaLicense {
  id: string;
  mediaId: string;
  mediaTitle: string;
  request: string;
  buyer: string;
  verified: boolean; // did the media's provenance actually support the request?
  score: number | null;
  verdict: "SUPPORTED" | "REFUSED";
  reason: string;
  methods: string[];
  verificationId?: string;
  licensedAt: string;
  settlement?: { paidUsdc: number; custody: boolean; ownerId: string; blocked?: string; tx?: string; explorerUrl?: string; onchain?: { outcome: string; jobId: string; steps: number } | null } | null;
  // signed merit.license/v1 fields (offline-verifiable)
  schema?: string;
  signer?: string;
  signature?: string;
}

interface MediaLog {
  media: MediaItem[];
  licenses: MediaLicense[];
}

const DOC = "media";
const MAX_MEDIA = 1000;
const MAX_LICENSES = 2000;
const MAX_PRICE = 5;
const PREVIEW = 600;

let cache: MediaLog | null = null;
function load(): MediaLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<MediaLog>(DOC, { media: [], licenses: [] });
  if (!value.media) value.media = [];
  if (!value.licenses) value.licenses = [];
  if (cacheable) cache = value;
  return value;
}
export async function refreshMediaFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<MediaLog>(DOC);
  if (v && Array.isArray(v.media) && Array.isArray(v.licenses)) cache = v;
}
function persist(log: MediaLog): void {
  cache = log;
  saveDoc(DOC, log);
}
function newId(): string {
  return BigInt("0x" + randomBytes(8).toString("hex")).toString(36).slice(0, 11);
}

export function getMedia(id: string): MediaItem | undefined {
  return id ? load().media.find((m) => m.id === id) : undefined;
}
export function listMedia(limit = 40): MediaItem[] {
  const m = load().media;
  return m.slice(Math.max(0, m.length - limit)).reverse();
}
export function listLicenses(limit = 30): MediaLicense[] {
  const l = load().licenses;
  return l.slice(Math.max(0, l.length - limit)).reverse();
}
export function mediaStats(): { media: number; licenses: number; verified: number; releasedUsdc: number } {
  const log = load();
  let releasedUsdc = 0;
  for (const l of log.licenses) if (l.settlement && !l.settlement.blocked) releasedUsdc = round6(releasedUsdc + l.settlement.paidUsdc);
  return { media: log.media.length, licenses: log.licenses.length, verified: log.licenses.filter((l) => l.verified).length, releasedUsdc };
}

export interface RegisterMediaInput {
  title: string;
  description: string;
  transcript?: string;
  url?: string;
  mediaType?: string;
  owner: string;
  ownerAddress?: string;
  priceUsdc: number;
  attestation?: string;
}

export function registerMedia(input: RegisterMediaInput): { media: MediaItem } | { error: string; status: number } {
  const title = (input.title || "").trim().slice(0, 160);
  const description = (input.description || "").trim().slice(0, 4000);
  const owner = (input.owner || "").trim().slice(0, 80) || "anonymous";
  const priceUsdc = round6(Number(input.priceUsdc) || 0);
  if (!title || !description) return { error: "provide { title, description } for the media", status: 400 };
  if (!(priceUsdc > 0)) return { error: "provide a positive { priceUsdc } license price", status: 400 };
  if (priceUsdc > MAX_PRICE) return { error: `price exceeds the demo ceiling of ${MAX_PRICE} USDC`, status: 400 };
  const mt = (["image", "video", "audio", "other"] as const).includes(input.mediaType as MediaType) ? (input.mediaType as MediaType) : "other";

  const media: MediaItem = {
    id: newId(),
    title,
    description,
    transcript: (input.transcript || "").trim().slice(0, 16000) || undefined,
    url: (input.url || "").trim() || undefined,
    mediaType: mt,
    owner,
    ownerAddress: input.ownerAddress,
    priceUsdc,
    attestation: (input.attestation || "").trim().slice(0, 400) || undefined,
    createdAt: new Date().toISOString(),
  };
  const log = load();
  log.media.push(media);
  if (log.media.length > MAX_MEDIA) log.media = log.media.slice(-MAX_MEDIA);
  persist(log);
  return { media };
}

export interface LicenseInput {
  mediaId: string;
  request: string;
  buyer: string;
  /** Release payment to the owner on a verified match — route sets true only for an authenticated principal. */
  settle?: boolean;
}

/**
 * License a media item for a request: verify the media's own description + transcript genuinely SUPPORT the
 * request (provenance), and on a real match release the license fee to the owner (claimable custody,
 * compliance-screened, proven on-chain by the hook when enabled). A non-match issues a REFUSED license and pays
 * nothing. Returns the signed license or a typed error. Never throws.
 */
export async function licenseMedia(input: LicenseInput): Promise<{ license: MediaLicense } | { error: string; status: number }> {
  const media = getMedia(input.mediaId);
  if (!media) return { error: "media not found", status: 404 };
  const request = (input.request || "").trim();
  const buyer = (input.buyer || "anonymous").trim().slice(0, 80) || "anonymous";
  if (!request) return { error: "provide the { request } — what you need the media to be/show", status: 400 };

  // The provenance source: the media's OWN metadata. The gate asks "does this media, as described, support the
  // request?" — the same faithfulness check that gates a citation.
  const provenance = [media.title, media.description, media.transcript || ""].filter(Boolean).join("\n");
  const outcome = await verifyCitation(request, provenance, {});
  if (isVerifyError(outcome)) return { error: `could not verify the media provenance: ${outcome.error}`, status: outcome.status };
  const v = outcome.verdict;
  const verified = v.verdict === "SUPPORTED";

  const license: MediaLicense = {
    id: newId(),
    mediaId: media.id,
    mediaTitle: media.title,
    request,
    buyer,
    verified,
    score: v.score,
    verdict: v.verdict,
    reason: verified
      ? `The media's provenance supports the request — licensed.${v.score !== null ? ` (match ${v.score.toFixed(3)})` : ""}`
      : `The media's description/transcript does NOT support the request — no license, no payment. You never pay for media that isn't what it claims.`,
    methods: v.methods,
    verificationId: v.verificationId,
    licensedAt: new Date().toISOString(),
    settlement: null,
  };

  // Sign the license certificate (merit.license/v1) so a third party can recover the signer offline.
  try {
    const body = { schema: "merit.license/v1", mediaId: media.id, request, verdict: v.verdict, verified, verificationId: v.verificationId, licensedAt: license.licensedAt };
    const sig = await signReceipt(body);
    license.schema = "merit.license/v1";
    if (sig) {
      license.signer = sig.signer;
      license.signature = sig.signature;
    }
  } catch {
    /* signing best-effort */
  }

  if (verified && input.settle) {
    license.settlement = await releaseLicense(media, v.verificationId);
  } else if (verified) {
    license.settlement = { paidUsdc: 0, custody: true, ownerId: ownerIdOf(media), blocked: "verified match — connect an API key (Authorization: Bearer <key>) to release the license fee to the owner", onchain: null };
  }

  const log = load();
  log.licenses.push(license);
  if (log.licenses.length > MAX_LICENSES) log.licenses = log.licenses.slice(-MAX_LICENSES);
  persist(log);
  return { license };
}

function ownerIdOf(media: MediaItem): string {
  return `media:${(media.ownerAddress || media.owner).toLowerCase().replace(/[^a-z0-9:]+/g, "-")}`;
}

/** Release the license fee to the owner on a verified match: compliance-screen, accrue claimable custody, and
 *  prove the release on-chain via the hook when enabled. Returns the settlement (blocked if the payee fails). */
async function releaseLicense(media: MediaItem, vId: string | undefined): Promise<NonNullable<MediaLicense["settlement"]>> {
  const ownerId = ownerIdOf(media);
  const amount = round6(media.priceUsdc);

  if (media.ownerAddress) {
    try {
      const gate = await assertPayeeCompliant(media.ownerAddress);
      if (!gate.allowed) return { paidUsdc: 0, custody: true, ownerId, blocked: `payout withheld by compliance screening — ${gate.screen.reason} (${gate.screen.source})`, onchain: null };
    } catch {
      /* the custody CLAIM re-screens before any on-chain disbursement */
    }
  }

  try {
    await refreshCustodyFromMirror();
    accrueCustody(ownerId, media.owner, amount);
  } catch {
    /* accrual best-effort */
  }

  const settlement: NonNullable<MediaLicense["settlement"]> = { paidUsdc: amount, custody: true, ownerId, onchain: null };
  if (jobHookEnabled()) {
    try {
      const hookRes = await settleViaHook({
        amountAtomic: BigInt(Math.round(amount * 1e6)),
        verified: true,
        deliverableHash: keccak256(toHex(`${media.id}:${media.title}`)),
        proofHash: (vId as `0x${string}`) || (`0x${"0".repeat(64)}` as `0x${string}`),
        description: `merit media license: ${media.title}`.slice(0, 120),
      });
      if (hookRes) {
        settlement.onchain = { outcome: hookRes.outcome, jobId: hookRes.jobId, steps: hookRes.txs.length };
        const rel = hookRes.txs.find((t) => t.step.startsWith("complete"));
        if (rel) {
          settlement.tx = rel.hash;
          settlement.explorerUrl = `https://testnet.arcscan.app/tx/${rel.hash}`;
        }
      }
    } catch {
      /* the accrual stands; on-chain proof is best-effort */
    }
  }
  return settlement;
}

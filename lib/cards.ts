/**
 * Shareable verification cards — the "car" surface. Every verification done through the public tool (and every
 * verified/refused citation settled in a run) is persisted as a CARD with a short public id, so it gets a
 * permalink (`/v/<id>`) anyone can open, share, and unfurl (dynamic OG image). A card captures the claim, the
 * source (a preview, never the full text), the three-gate breakdown, the signed verdict, and — for settlements
 * — the USDC paid + on-chain tx. This turns Merit's invisible verification into a linkable, screenshottable
 * artifact. Store-backed (+ Supabase mirror); holds no private keys.
 */
import { randomBytes } from "node:crypto";
import type { GateBreakdown, Verdict } from "./verify/engine";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

export interface VerifyCard {
  id: string;
  kind: "verify" | "settlement";
  claim: string;
  sourcePreview: string; // first chars of the source — enough to show provenance, not the whole text
  sourceUrl?: string;
  sourceName?: string; // the creator/source name (settlement cards)
  verdict: "SUPPORTED" | "REFUSED";
  grounded: boolean;
  score: number | null;
  methods: string[];
  reason: string;
  gates?: GateBreakdown;
  modelTag: string;
  depth?: "numeric" | "nli" | "full"; // the verification depth tier this verdict was produced at (default full)
  // The four signed-verdict fields not otherwise on the card — stored so the EXACT signed body can be
  // reconstructed and the signer recovered offline (backs the receipt's "verify without trusting Merit" claim).
  schema?: string;
  engineVersion?: string;
  sourceHash?: string;
  verifiedAt?: string;
  verificationId?: string; // the join key (keccak of the signed verdict) — ties this receipt to its 402 charge, the /proof ledger, and the on-chain hook
  signer?: string;
  signature?: string;
  paidUsdc?: number; // settlement cards: USDC released to the source (on-chain settle OR custody accrual)
  custody?: boolean; // true when paidUsdc is a CUSTODY accrual (held for a wallet-less creator, claimable via
  // domain proof) — NOT an on-chain settlement. Kept distinct so the receipt never labels an accrual "settled".
  splits?: { name: string; amount: number }[]; // when the accrual was DISTRIBUTED across contributors, the
  // per-recipient breakdown — so the receipt attributes each share to who actually got it, not to the collective.
  tx?: string;
  explorerUrl?: string;
  createdAt: string;
}

interface CardLog {
  entries: VerifyCard[];
}

const DOC = "cards";
const MAX_CARDS = 5000; // bound the in-repo log; oldest roll off
const PREVIEW_CHARS = 600;

let cache: CardLog | null = null;
function load(): CardLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<CardLog>(DOC, { entries: [] });
  if (!value.entries) value.entries = [];
  if (cacheable) cache = value;
  return value;
}

/** Read-your-writes refresh from the durable mirror before a read/write on serverless (a warm instance would
 *  otherwise miss cards created on another instance). No-op off the ephemeral Supabase mirror. */
export async function refreshCardsFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<CardLog>(DOC);
  if (v && Array.isArray(v.entries)) cache = v;
}

/** Short, url-safe, unguessable id (base36 of random bytes) — a receipt permalink slug. */
export function newCardId(): string {
  return BigInt("0x" + randomBytes(8).toString("hex")).toString(36).slice(0, 11);
}

/** Build a card body from a signed Verdict + presentation extras. */
export function cardFromVerdict(
  v: Verdict,
  extra: { kind?: "verify" | "settlement"; source: string; sourceUrl?: string; sourceName?: string; depth?: "numeric" | "nli" | "full"; paidUsdc?: number; custody?: boolean; splits?: { name: string; amount: number }[]; tx?: string; explorerUrl?: string; createdAt: string },
): VerifyCard {
  return {
    id: newCardId(),
    kind: extra.kind ?? "verify",
    claim: v.claim,
    sourcePreview: (extra.source || "").slice(0, PREVIEW_CHARS),
    sourceUrl: extra.sourceUrl,
    sourceName: extra.sourceName,
    verdict: v.verdict,
    grounded: v.grounded,
    score: v.score,
    methods: v.methods,
    reason: v.reason,
    gates: v.gates,
    modelTag: v.modelTag,
    depth: extra.depth,
    schema: v.schema,
    engineVersion: v.engineVersion,
    sourceHash: v.sourceHash,
    verifiedAt: v.verifiedAt,
    verificationId: v.verificationId,
    signer: v.signer,
    signature: v.signature,
    paidUsdc: extra.paidUsdc,
    custody: extra.custody,
    splits: extra.splits,
    tx: extra.tx,
    explorerUrl: extra.explorerUrl,
    createdAt: extra.createdAt,
  };
}

/** Persist a card (append, cap, mirror). Best-effort; never throws into a caller. Returns the stored card. */
export function saveCard(card: VerifyCard): VerifyCard {
  try {
    const log = load();
    log.entries.push(card);
    if (log.entries.length > MAX_CARDS) log.entries = log.entries.slice(-MAX_CARDS);
    cache = log;
    saveDoc(DOC, log);
  } catch (e) {
    console.error("[cards] save failed:", (e as Error).message);
  }
  return card;
}

export function getCard(id: string): VerifyCard | undefined {
  if (!id) return undefined;
  return load().entries.find((c) => c.id === id);
}

/**
 * Reconstruct the EXACT object the engine signed (merit.cvo/v2 body + signer/signature), so a third party can
 * recover the signer offline (canonicalize the rest, recoverMessageAddress) and confirm it equals `signer` —
 * no need to trust Merit's server. Returns null when the card predates full-body storage or is unsigned (an
 * honest "not offline-verifiable" rather than a body that won't recover). Field set must match lib/verify/engine.ts.
 */
export function signedReceipt(c: VerifyCard): (Record<string, unknown> & { signer: string; signature: string }) | null {
  if (!c.signer || !c.signature) return null;
  if (!c.schema || !c.engineVersion || !c.sourceHash || !c.verifiedAt || !c.gates) return null;
  return {
    schema: c.schema,
    engineVersion: c.engineVersion,
    claim: c.claim,
    sourceHash: c.sourceHash,
    verdict: c.verdict,
    grounded: c.grounded,
    score: c.score,
    methods: c.methods,
    reason: c.reason,
    modelTag: c.modelTag,
    verifiedAt: c.verifiedAt,
    gates: c.gates,
    signer: c.signer,
    signature: c.signature,
  };
}

/** Newest-first slice, optionally filtered by kind — for the public receipts gallery / honesty feed. */
export function listCards(limit = 24, kind?: "verify" | "settlement"): VerifyCard[] {
  const e = load().entries;
  const filtered = kind ? e.filter((c) => c.kind === kind) : e;
  return filtered.slice(Math.max(0, filtered.length - limit)).reverse();
}

export function cardCount(): number {
  return load().entries.length;
}

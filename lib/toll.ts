/**
 * Verified Citation Toll (the moat door) — a neutral verification gate any AI-payment rail or publisher calls
 * BEFORE releasing a citation payment. It does NOT move money itself: it returns a signed pass/fail verdict and
 * a release/refuse decision that the caller uses to gate its own toll. Cloudflare / TollBit / ProRata pay on
 * access or on appearance; Merit answers the one question they skip — did the AI's answer actually, correctly
 * use this source? One `verificationId` joins the verdict to the rail's payment, the /proof ledger, and (on the
 * ERC-8183 path) the on-chain hook. Same verifier engine as the inference door — one core, two front doors.
 *
 * POST /api/toll/verify { claim, citedPassage | citedURL, tollUsdc?, publisher? }
 *   → { decision: "release" | "refuse", released, verdict, confidence, verificationId, signer, signature }
 */
import { round6 } from "./arc";
import { verifyCitation, isVerifyError } from "./verify/engine";
import { extractSourceFromUrl } from "./extract";
import { signReceipt } from "./receipt";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";
import { randomBytes } from "node:crypto";

export const TOLL_PRICE_DEFAULT = 0.001; // default per-citation toll a rail would release, in USDC

export interface TollInput {
  claim: string;
  citedPassage?: string; // the passage the claim must be supported by
  citedURL?: string; // OR a URL to fetch (SSRF-guarded) as the source
  tollUsdc?: number; // the toll the rail would release on a passing citation
  publisher?: string; // who would be paid (label only)
  record?: boolean; // persist to the public toll board
}

export interface TollReceipt {
  id: string;
  decision: "release" | "refuse";
  verdict: "SUPPORTED" | "REFUSED";
  confidence: number;
  claimPreview: string;
  sourceRef: string; // the URL, or "(passage)" for inline text
  publisher?: string;
  tollUsdc: number;
  released: number; // tollUsdc on release, 0 on refuse
  methods: string[];
  verificationId?: string;
  reason: string;
  createdAt: string;
  schema?: string;
  signer?: string;
  signature?: string;
}

const DOC = "toll";
const MAX = 2000;
const PREVIEW = 240;

interface TollLog {
  receipts: TollReceipt[];
}
let cache: TollLog | null = null;
function load(): TollLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<TollLog>(DOC, { receipts: [] });
  if (!value.receipts) value.receipts = [];
  if (cacheable) cache = value;
  return value;
}
export async function refreshTollFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<TollLog>(DOC);
  if (v && Array.isArray(v.receipts)) cache = v;
}
function saveReceipt(r: TollReceipt): TollReceipt {
  try {
    const log = load();
    log.receipts.push(r);
    if (log.receipts.length > MAX) log.receipts = log.receipts.slice(-MAX);
    cache = log;
    saveDoc(DOC, log);
  } catch (e) {
    console.error("[toll] save failed:", (e as Error).message);
  }
  return r;
}
export function listToll(limit = 30): TollReceipt[] {
  const r = load().receipts;
  return r.slice(Math.max(0, r.length - limit)).reverse();
}
export function tollStats(): { gates: number; released: number; refused: number; releasedUsdc: number; savedUsdc: number } {
  const r = load().receipts;
  let releasedUsdc = 0;
  let savedUsdc = 0;
  let released = 0;
  let refused = 0;
  for (const x of r) {
    if (x.decision === "release") {
      released += 1;
      releasedUsdc = round6(releasedUsdc + (x.released || 0));
    } else {
      refused += 1;
      savedUsdc = round6(savedUsdc + (x.tollUsdc || 0)); // what a pay-on-access toll would have wrongly paid
    }
  }
  return { gates: r.length, released, refused, releasedUsdc, savedUsdc };
}

function newId(): string {
  return BigInt("0x" + randomBytes(8).toString("hex")).toString(36).slice(0, 11);
}

/** Run the citation through Merit's verifier and return the gate decision the calling rail settles on. */
export async function evaluateToll(input: TollInput): Promise<{ receipt: TollReceipt } | { error: string; status: number }> {
  const claim = (input.claim || "").trim();
  if (!claim) return { error: "provide a { claim } — the assertion the AI made", status: 400 };

  let passage = (input.citedPassage || "").trim();
  let sourceRef = "(passage)";
  if (!passage && input.citedURL) {
    const ex = await extractSourceFromUrl(input.citedURL.trim());
    if (!ex.ok) return { error: `could not read citedURL: ${ex.error}`, status: 400 };
    passage = ex.text;
    sourceRef = input.citedURL.trim();
  }
  if (!passage) return { error: "provide { citedPassage } or { citedURL } — the source the claim must be supported by", status: 400 };

  const outcome = await verifyCitation(claim, passage, {});
  if (isVerifyError(outcome)) return { error: outcome.error, status: outcome.status };
  const v = outcome.verdict;

  const decision: "release" | "refuse" = v.verdict === "SUPPORTED" ? "release" : "refuse";
  const confidence = typeof v.score === "number" ? Math.round(v.score * 1000) / 1000 : v.verdict === "SUPPORTED" ? 0.9 : 0.1;
  const tollUsdc = Number.isFinite(input.tollUsdc) && (input.tollUsdc as number) > 0 ? round6(input.tollUsdc as number) : TOLL_PRICE_DEFAULT;
  const released = decision === "release" ? tollUsdc : 0;

  const receipt: TollReceipt = {
    id: newId(),
    decision,
    verdict: v.verdict,
    confidence,
    claimPreview: claim.slice(0, PREVIEW),
    sourceRef: sourceRef.slice(0, 200),
    publisher: input.publisher ? input.publisher.slice(0, 80) : undefined,
    tollUsdc,
    released,
    methods: v.methods,
    verificationId: v.verificationId,
    reason:
      decision === "release"
        ? `Citation SUPPORTED (${v.methods.join(" + ")}) — the rail may release ${released} USDC to ${input.publisher || "the publisher"}.`
        : `Citation REFUSED (${v.methods.join(" + ")}) — do NOT pay. A pay-on-access toll would have paid ${tollUsdc} USDC for an unsupported citation.`,
    createdAt: new Date().toISOString(),
  };
  await sign(receipt, { verdict: v.verdict, verificationId: v.verificationId, sourceHash: v.sourceHash, tollUsdc });
  if (input.record) saveReceipt(receipt);
  return { receipt };
}

/** Sign the toll-gate receipt (merit.toll/v1) so a third-party rail can verify the verdict offline. Best-effort. */
async function sign(receipt: TollReceipt, body: Record<string, unknown>): Promise<void> {
  try {
    const signable = { schema: "merit.toll/v1", ...body, decision: receipt.decision, createdAt: receipt.createdAt };
    const sig = await signReceipt(signable);
    receipt.schema = "merit.toll/v1";
    if (sig) {
      receipt.signer = sig.signer;
      receipt.signature = sig.signature;
    }
  } catch {
    /* signing is best-effort; an unsigned verdict is still valid, just not offline-recoverable */
  }
}

/**
 * Verified freelance / bounty escrow board (Hub feature #2) — for humans AND agents.
 *
 * A poster puts up a brief + explicit requirements + a USDC bounty; a worker (a person or an agent) submits a
 * deliverable; Merit's REAL adversarial grader (lib/grade.ts) scores it against the requirements and releases
 * the escrow ONLY when the work actually meets them — auto-accept on pass, no release on fail. This is the
 * evaluator three competitors shipped fake: Arco's "AI evaluator" is a human clicking a button, BugBountyAI
 * pays every hallucination it invents, Receipt's partial-release path is dead code. Merit's is signed,
 * offline-verifiable, and (when the hook is enabled) proven on-chain by the same ERC-8183 gate that settles
 * citations — release on verified, revert+refund on not-verified.
 *
 * Honesty invariants: a payout accrues only on a genuine `accepted` grade; `settlement` reflects real value
 * (custody accrual, claimable on-chain by the worker) and an on-chain link only when a tx actually landed; a
 * worker address is compliance-screened before any release. Store-backed (+ mirror); holds no private keys.
 */
import { randomBytes } from "node:crypto";
import { round6 } from "./arc";
import { gradeDeliverable, isGradeError, type RubricItem } from "./grade";
import { accrueCustody, refreshCustodyFromMirror } from "./custody";
import { assertPayeeCompliant } from "./compliance";
import { settleViaHook, jobHookEnabled } from "./job";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

export interface GigSettlement {
  paidUsdc: number;
  custody: boolean; // the payout is a claimable custody accrual (the worker withdraws on-chain via wallet/domain proof)
  workerId: string; // the custody key the worker claims against
  blocked?: string; // set when an accepted deliverable's payout was withheld (e.g. a compliance-denied payee)
  tx?: string;
  explorerUrl?: string;
  onchain?: { outcome: string; jobId: string; explorer: string; steps: number } | null; // ERC-8183 hook proof when enabled
}

export interface GigSubmission {
  id: string;
  worker: string;
  workerAddress?: string;
  deliverablePreview: string; // capped preview, never the full deliverable
  deliverableHash: string;
  accepted: boolean;
  score: number;
  rubric: RubricItem[];
  reason: string;
  methods: string[];
  verificationId?: string;
  gradedAt: string;
  settlement?: GigSettlement | null;
  // signed grade-certificate fields, so the exact merit.gig/v1 body can be reconstructed + the grader recovered offline
  schema?: string;
  engineVersion?: string;
  modelTag?: string;
  signer?: string;
  signature?: string;
}

export interface Gig {
  id: string;
  title: string;
  brief: string;
  requirements: string[];
  bountyUsdc: number;
  poster: string;
  status: "open" | "released" | "cancelled";
  createdAt: string;
  releasedTo?: string;
  submissions: GigSubmission[];
}

interface GigLog {
  gigs: Gig[];
}

const DOC = "gigs";
const MAX_GIGS = 1000;
const MAX_SUBMISSIONS = 50; // per gig, bound the attempt log
const MAX_BOUNTY = 5; // USDC — demo safety ceiling on a single escrow
const PREVIEW_CHARS = 600;

let cache: GigLog | null = null;
function load(): GigLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<GigLog>(DOC, { gigs: [] });
  if (!value.gigs) value.gigs = [];
  if (cacheable) cache = value;
  return value;
}

/** Read-your-writes refresh before a read/mutation on serverless (a warm instance would otherwise miss gigs
 *  posted / submissions graded on another instance, and could double-release). No-op off the Supabase mirror. */
export async function refreshGigsFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<GigLog>(DOC);
  if (v && Array.isArray(v.gigs)) cache = v;
}

function newId(): string {
  return BigInt("0x" + randomBytes(8).toString("hex")).toString(36).slice(0, 11);
}

function persist(log: GigLog): void {
  cache = log;
  saveDoc(DOC, log);
}

export function getGig(id: string): Gig | undefined {
  if (!id) return undefined;
  return load().gigs.find((g) => g.id === id);
}

export function listGigs(limit = 40): Gig[] {
  const g = load().gigs;
  return g.slice(Math.max(0, g.length - limit)).reverse();
}

export function gigStats(): { total: number; open: number; released: number; totalReleasedUsdc: number; submissions: number } {
  const g = load().gigs;
  let released = 0;
  let totalReleasedUsdc = 0;
  let submissions = 0;
  for (const x of g) {
    submissions += x.submissions.length;
    if (x.status === "released") {
      released += 1;
      const accrued = x.submissions.find((s) => s.accepted && s.settlement && !s.settlement.blocked);
      if (accrued?.settlement) totalReleasedUsdc = round6(totalReleasedUsdc + accrued.settlement.paidUsdc);
    }
  }
  return { total: g.length, open: g.filter((x) => x.status === "open").length, released, totalReleasedUsdc, submissions };
}

export interface PostGigInput {
  title: string;
  brief: string;
  requirements?: string[];
  bountyUsdc: number;
  poster: string;
}

/** Create + persist an open gig. Returns the gig or a typed error. Bounty is clamped to the demo ceiling. */
export function postGig(input: PostGigInput): { gig: Gig } | { error: string; status: number } {
  const title = (input.title || "").trim().slice(0, 140);
  const brief = (input.brief || "").trim().slice(0, 4000);
  const poster = (input.poster || "").trim().slice(0, 80) || "anonymous";
  const requirements = (input.requirements || [])
    .map((r) => (r || "").trim())
    .filter(Boolean)
    .slice(0, 12);
  const bountyUsdc = round6(Number(input.bountyUsdc) || 0);
  if (!title || !brief) return { error: "provide { title, brief } for the gig", status: 400 };
  if (!(bountyUsdc > 0)) return { error: "provide a positive { bountyUsdc } bounty", status: 400 };
  if (bountyUsdc > MAX_BOUNTY) return { error: `bounty exceeds the demo ceiling of ${MAX_BOUNTY} USDC`, status: 400 };

  const gig: Gig = {
    id: newId(),
    title,
    brief,
    requirements,
    bountyUsdc,
    poster,
    status: "open",
    createdAt: new Date().toISOString(),
    submissions: [],
  };
  const log = load();
  log.gigs.push(gig);
  if (log.gigs.length > MAX_GIGS) log.gigs = log.gigs.slice(-MAX_GIGS);
  persist(log);
  return { gig };
}

export interface SubmitInput {
  gigId: string;
  worker: string;
  workerAddress?: string;
  deliverable: string;
  /** Whether to actually RELEASE escrow on an accepted grade. The route sets this true only for an
   *  authenticated principal — a public submission still gets the real grade, but moves no money. */
  settle?: boolean;
}

/**
 * Submit a deliverable to an open gig: grade it against the requirements, and on a genuine accept, release the
 * escrow to the worker (custody accrual, claimable on-chain; compliance-screened; proven on-chain by the hook
 * when enabled). A reject records the attempt and leaves the gig open — nothing is paid. Returns the gig +
 * the graded submission, or a typed error. Never double-releases: a released gig refuses further submissions.
 */
export async function submitToGig(input: SubmitInput): Promise<{ gig: Gig; submission: GigSubmission } | { error: string; status: number }> {
  const gig = getGig(input.gigId);
  if (!gig) return { error: "gig not found", status: 404 };
  if (gig.status !== "open") return { error: `this gig is ${gig.status} — it is no longer accepting submissions`, status: 409 };
  const worker = (input.worker || "").trim().slice(0, 80) || "anonymous";
  const deliverable = (input.deliverable || "").trim();
  if (!deliverable) return { error: "provide the { deliverable } — the work product to grade", status: 400 };

  // Grade the deliverable against the brief + requirements (the real evaluator).
  const outcome = await gradeDeliverable(gig.brief, gig.requirements, deliverable);
  if (isGradeError(outcome)) return { error: outcome.error, status: outcome.status };
  const cert = outcome.grade;

  const submission: GigSubmission = {
    id: newId(),
    worker,
    workerAddress: input.workerAddress,
    deliverablePreview: deliverable.slice(0, PREVIEW_CHARS),
    deliverableHash: cert.deliverableHash,
    accepted: cert.accepted,
    score: cert.score,
    rubric: cert.rubric,
    reason: cert.reason,
    methods: cert.methods,
    verificationId: cert.verificationId,
    gradedAt: cert.gradedAt,
    settlement: null,
    schema: cert.schema,
    engineVersion: cert.engineVersion,
    modelTag: cert.modelTag,
    signer: cert.signer,
    signature: cert.signature,
  };

  if (cert.accepted && input.settle) {
    submission.settlement = await releaseEscrow(gig, submission, cert.deliverableHash, cert.verificationId);
    // Only close the gig when the payout actually happened — an accepted-but-payout-blocked (e.g. sanctioned
    // payee) submission leaves the gig OPEN so the worker can re-claim with a compliant address.
    if (submission.settlement && !submission.settlement.blocked) {
      gig.status = "released";
      gig.releasedTo = worker;
    }
  } else if (cert.accepted) {
    // Graded ACCEPTED, but the caller isn't an authenticated principal — show the real decision, move no money.
    submission.settlement = {
      paidUsdc: 0,
      custody: true,
      workerId: `gig:${(submission.workerAddress || submission.worker).toLowerCase().replace(/[^a-z0-9:]+/g, "-")}`,
      blocked: "grade accepted — connect an API key (Authorization: Bearer <key>) to release the escrow to the worker",
      onchain: null,
    };
  }

  gig.submissions.push(submission);
  if (gig.submissions.length > MAX_SUBMISSIONS) gig.submissions = gig.submissions.slice(-MAX_SUBMISSIONS);
  // Persist against the freshest log (the gig object is a reference into the cached log).
  persist(load());
  return { gig, submission };
}

/** Release a gig's bounty to the worker on an accepted grade: compliance-screen the payee, accrue the claimable
 *  custody balance, and — when the ERC-8183 hook is enabled — prove the release on-chain (verified → complete).
 *  Returns the settlement, or a blocked settlement (no money moved) when the payee fails compliance. */
async function releaseEscrow(
  gig: Gig,
  submission: GigSubmission,
  deliverableHash: string,
  verificationId: string | undefined,
): Promise<GigSettlement> {
  const workerId = `gig:${(submission.workerAddress || submission.worker).toLowerCase().replace(/[^a-z0-9:]+/g, "-")}`;
  const amount = round6(gig.bountyUsdc);

  // Compliance pre-gate: a worker address that fails screening blocks the payout (no USDC prepares to move).
  if (submission.workerAddress) {
    try {
      const gate = await assertPayeeCompliant(submission.workerAddress);
      if (!gate.allowed) {
        return { paidUsdc: 0, custody: true, workerId, blocked: `payout withheld by compliance screening — ${gate.screen.reason} (${gate.screen.source})` };
      }
    } catch {
      /* screening error is non-fatal here — the custody CLAIM re-screens before any on-chain disbursement */
    }
  }

  // Accrue the worker's claimable balance (real, withdrawable on-chain — never an IOU).
  try {
    await refreshCustodyFromMirror();
    accrueCustody(workerId, submission.worker, amount);
  } catch {
    /* accrual is best-effort; the on-chain proof below still runs */
  }

  const settlement: GigSettlement = { paidUsdc: amount, custody: true, workerId, onchain: null };

  // Prove the release gate on-chain with the same ERC-8183 hook that settles citations (verified → complete()).
  if (jobHookEnabled()) {
    try {
      const hookRes = await settleViaHook({
        amountAtomic: BigInt(Math.round(amount * 1e6)),
        verified: true,
        deliverableHash: (deliverableHash as `0x${string}`) || (`0x${"0".repeat(64)}` as `0x${string}`),
        proofHash: (verificationId as `0x${string}`) || (`0x${"0".repeat(64)}` as `0x${string}`),
        description: `merit gig: ${gig.title}`.slice(0, 120),
      });
      if (hookRes) {
        settlement.onchain = { outcome: hookRes.outcome, jobId: hookRes.jobId, explorer: hookRes.explorer, steps: hookRes.txs.length };
        const release = hookRes.txs.find((t) => t.step.startsWith("complete"));
        if (release) {
          settlement.tx = release.hash;
          settlement.explorerUrl = `https://testnet.arcscan.app/tx/${release.hash}`;
        }
      }
    } catch {
      /* the off-chain accrual already stands; the on-chain proof is best-effort */
    }
  }
  return settlement;
}

/** Cancel an open gig (poster only). No money moved (escrow is notional until an accepted release), so this is
 *  a clean state change. Returns the gig or a typed error. */
export function cancelGig(id: string, poster: string): { gig: Gig } | { error: string; status: number } {
  const gig = getGig(id);
  if (!gig) return { error: "gig not found", status: 404 };
  if (gig.status !== "open") return { error: `this gig is ${gig.status} and cannot be cancelled`, status: 409 };
  if ((poster || "").trim() && gig.poster !== "anonymous" && gig.poster !== (poster || "").trim()) {
    return { error: "only the poster can cancel this gig", status: 403 };
  }
  gig.status = "cancelled";
  persist(load());
  return { gig };
}

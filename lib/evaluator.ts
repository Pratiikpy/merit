/**
 * ERC-8183 Evaluator-of-record (cat 4, the moat move) — Merit's adversarial deliverable-vs-brief grader exposed
 * as a NEUTRAL, reusable evaluator that ANY external ERC-8183 escrow or agent-labor market can call. The
 * ERC-8183 evaluator slot on Arc is usually "a bare address with zero verification logic"; Merit fills it with a
 * real grader that returns a signed accept/reject verdict the escrow's own hook settles on — Merit does not hold
 * the escrow. A dispute is resolved by DETERMINISTIC re-evaluation of the same deliverable (same deliverableHash
 * → same verdict), never a subjective juror court. Same engine family as the citation toll — one core, many doors.
 *
 * POST /api/evaluator { brief, requirements?, deliverable, escrowUsdc?, jobRef? }
 *   → { decision: "release" | "refund", released, certificate (signed merit.gig/v1), verificationId }
 */
import { round6 } from "./arc";
import { gradeDeliverable, isGradeError, type GradeCertificate } from "./grade";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";
import { randomBytes } from "node:crypto";

export const ESCROW_DEFAULT = 0.01; // default escrow a job would release on an accepted deliverable, in USDC

export interface EvaluatorInput {
  brief: string;
  requirements?: string[];
  deliverable: string;
  escrowUsdc?: number;
  jobRef?: string; // an external ERC-8183 job id / label
  allowOffline?: boolean; // deterministic lexical grade when no LLM (tests / offline demos); prod default false
  record?: boolean;
}

export interface EvaluatorReceipt {
  id: string;
  decision: "release" | "refund";
  accepted: boolean;
  score: number;
  briefPreview: string;
  jobRef?: string;
  escrowUsdc: number;
  released: number; // escrowUsdc on release, 0 on refund
  deliverableHash?: string;
  methods: string[];
  verificationId?: string;
  reason: string;
  certificate: GradeCertificate; // the full signed merit.gig/v1 grade the hook can reconstruct + verify offline
  createdAt: string;
}

const DOC = "evaluator";
const MAX = 2000;
const PREVIEW = 200;

interface EvalLog {
  receipts: EvaluatorReceipt[];
}
let cache: EvalLog | null = null;
function load(): EvalLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<EvalLog>(DOC, { receipts: [] });
  if (!value.receipts) value.receipts = [];
  if (cacheable) cache = value;
  return value;
}
export async function refreshEvaluatorFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<EvalLog>(DOC);
  if (v && Array.isArray(v.receipts)) cache = v;
}
function saveReceipt(r: EvaluatorReceipt): EvaluatorReceipt {
  try {
    const log = load();
    log.receipts.push(r);
    if (log.receipts.length > MAX) log.receipts = log.receipts.slice(-MAX);
    cache = log;
    saveDoc(DOC, log);
  } catch (e) {
    console.error("[evaluator] save failed:", (e as Error).message);
  }
  return r;
}
export function listEvaluator(limit = 30): EvaluatorReceipt[] {
  const r = load().receipts;
  return r.slice(Math.max(0, r.length - limit)).reverse();
}
export function evaluatorStats(): { evals: number; released: number; refunded: number; releasedUsdc: number; heldUsdc: number } {
  const r = load().receipts;
  let releasedUsdc = 0;
  let heldUsdc = 0;
  let released = 0;
  let refunded = 0;
  for (const x of r) {
    if (x.decision === "release") {
      released += 1;
      releasedUsdc = round6(releasedUsdc + (x.released || 0));
    } else {
      refunded += 1;
      heldUsdc = round6(heldUsdc + (x.escrowUsdc || 0)); // escrow a naive market would have wrongly paid out
    }
  }
  return { evals: r.length, released, refunded, releasedUsdc, heldUsdc };
}

function newId(): string {
  return BigInt("0x" + randomBytes(8).toString("hex")).toString(36).slice(0, 11);
}

/** Grade the deliverable against the brief and return the settlement verdict the calling escrow's hook consumes. */
export async function evaluate(input: EvaluatorInput): Promise<{ receipt: EvaluatorReceipt } | { error: string; status: number }> {
  const brief = (input.brief || "").trim();
  const deliverable = (input.deliverable || "").trim();
  if (!brief || !deliverable) return { error: "provide { brief, deliverable } — both raw text", status: 400 };

  const grade = await gradeDeliverable(brief, input.requirements || [], deliverable, { allowOffline: input.allowOffline });
  if (isGradeError(grade)) return { error: grade.error, status: grade.status };
  const cert = grade.grade;

  const decision: "release" | "refund" = cert.accepted ? "release" : "refund";
  const escrowUsdc = Number.isFinite(input.escrowUsdc) && (input.escrowUsdc as number) > 0 ? round6(input.escrowUsdc as number) : ESCROW_DEFAULT;
  const released = cert.accepted ? escrowUsdc : 0;

  const receipt: EvaluatorReceipt = {
    id: newId(),
    decision,
    accepted: cert.accepted,
    score: cert.score,
    briefPreview: brief.slice(0, PREVIEW),
    jobRef: input.jobRef ? input.jobRef.slice(0, 80) : undefined,
    escrowUsdc,
    released,
    deliverableHash: cert.deliverableHash,
    methods: cert.methods,
    verificationId: cert.verificationId,
    reason: cert.accepted
      ? `Deliverable ACCEPTED (${Math.round(cert.score * 100)}% of requirements met) — the escrow may release ${released} USDC.`
      : `Deliverable REJECTED (only ${Math.round(cert.score * 100)}% of requirements met) — do NOT release. A market that pays on delivery would have paid ${escrowUsdc} USDC for unmet work.`,
    certificate: cert,
    createdAt: new Date().toISOString(),
  };
  if (input.record) saveReceipt(receipt);
  return { receipt };
}

/**
 * Agent Treasury Guardrails — the SIGNED CONTROL PLANE (receipts all the way down). Circle's own framing:
 * "AI agents are moving to holding discretion over balance sheets." This is what makes that safe: every
 * disbursement an agent wants to make goes through ONE authorize call that composes Merit's existing gates —
 *
 *   1. operator guard    — kill-switch / frozen state (existing lib/guard)
 *   2. compliance        — Circle KYT screen + authoritative denylist, fail-closed (existing lib/compliance)
 *   3. policy            — a guardrails policy the SPENDING AGENT CANNOT EDIT (admin-token-authored, signed,
 *                          versioned; the agent has read-only access — anti self-escalation)
 *   4. rolling exposure  — cumulative per-counterparty spend over a sliding window, so many sub-cap payments
 *                          to one payee can't salami-slice past a per-transaction cap
 *   5. tx-simulation     — dry-run the transfer so a doomed payout is caught before gas (existing lib/simulate)
 *
 * and EVERY decision — allow AND block — is itself a keccak256-signed receipt persisted BEFORE the caller sees
 * it. Refusal receipts are proof the guardrail fired; "why did it block payroll at 3am" is one lookup, not a
 * log grep. A human override is its own signed receipt naming the operator, chained to the blocked receipt it
 * overrides.
 *
 * Honest boundaries (stated, not hidden):
 *   - Anti-self-escalation is as strong as the key separation. Policy is authored with MERIT_ADMIN_TOKEN and
 *     the agent spends with its API key — two credentials, hosted in one deployment. Treasury-grade separation
 *     puts the admin credential in separate custody (HSM / multisig); the policy receipt chain makes tampering
 *     visible either way.
 *   - Exposure counting on serverless: state is merged against the shared mirror on refresh and save (union by
 *     receipt id; exposure entries unioned), but two instances authorizing in the same instant can each admit a
 *     payment before either sees the other — the window cap is enforced within one instance's view and
 *     converges on merge, it is not a global atomic counter. Exposure is keyed per (principal, payee), so one
 *     caller's authorizations can never consume another principal's headroom (no cross-principal griefing).
 */
import { randomBytes } from "node:crypto";
import { round6 } from "./arc";
import { isFrozen, dailyCap } from "./guard";
import { screenAddress } from "./compliance";
import { simulateUsdcTransfer } from "./simulate";
import { signReceipt, verificationId } from "./receipt";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";

// ---- policy (guardrails.json — admin-authored, agent-read-only) -------------------------------------------

export interface GuardPolicy {
  version: number;
  maxPerTxUsdc: number; // hard per-transaction ceiling
  maxPerPayeeWindowUsdc: number; // rolling cumulative ceiling per counterparty
  windowHours: number; // the sliding window for the exposure counter
  requireSimulation: boolean; // refuse when the dry-run says the transfer would fail
  updatedAt: string;
  updatedBy: string; // "admin" — the credential class, never the agent's own key
  signer?: string;
  signature?: string;
  policyId?: `0x${string}`;
}

export const DEFAULT_POLICY: Omit<GuardPolicy, "updatedAt" | "updatedBy"> = {
  version: 1,
  maxPerTxUsdc: 0.25,
  maxPerPayeeWindowUsdc: 1,
  windowHours: 24,
  requireSimulation: false, // fail-open on sim by default: a sim OUTAGE shouldn't freeze payroll; a sim FAILURE still blocks
};

export interface GuardReceipt {
  id: string;
  decision: "allow" | "block" | "override";
  principal: string;
  payee: string;
  amountUsdc: number;
  reasons: string[]; // every gate that fired, in order — empty on a clean allow
  gates: { frozen: boolean; compliance: string; policy: string; exposure: string; simulation: string };
  policyVersion: number;
  exposureAfterUsdc: number; // this payee's rolling exposure including this decision (0-added when blocked)
  overrides?: string; // the blocked receipt id an override chains to
  operator?: string; // the named human on an override — liability has a name
  createdAt: string;
  schema?: string;
  signer?: string;
  signature?: string;
  receiptId?: `0x${string}`;
}

interface GuardPlaneDoc {
  policy: GuardPolicy | null;
  receipts: GuardReceipt[];
  exposure: Record<string, Array<{ at: number; amount: number }>>; // "principal|payee" → window entries
}

const DOC = "guardplane";
const MAX_RECEIPTS = 2000;
let cache: GuardPlaneDoc | null = null;
function load(): GuardPlaneDoc {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<GuardPlaneDoc>(DOC, { policy: null, receipts: [], exposure: {} });
  value.receipts ||= [];
  value.exposure ||= {};
  if (cacheable) cache = value;
  return value;
}
/** Merge, never clobber: union receipts by id and exposure entries by value, keep the higher policy version.
 *  A concurrent instance's signed receipts are never lost to a last-writer-wins overwrite. */
function mergeDocs(a: GuardPlaneDoc, b: GuardPlaneDoc): GuardPlaneDoc {
  const receipts = new Map<string, GuardReceipt>();
  for (const r of [...(a.receipts || []), ...(b.receipts || [])]) if (!receipts.has(r.id)) receipts.set(r.id, r);
  const exposure: GuardPlaneDoc["exposure"] = {};
  for (const src of [a.exposure || {}, b.exposure || {}]) {
    for (const [k, rows] of Object.entries(src)) {
      const seen = new Set((exposure[k] ||= []).map((r) => `${r.at}:${r.amount}`));
      for (const r of rows) if (!seen.has(`${r.at}:${r.amount}`)) exposure[k].push(r);
    }
  }
  const policy = !a.policy ? b.policy : !b.policy ? a.policy : (b.policy.version || 0) > (a.policy.version || 0) ? b.policy : a.policy;
  return { policy, receipts: [...receipts.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt)), exposure };
}
export async function refreshGuardPlaneFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<GuardPlaneDoc>(DOC);
  if (v && Array.isArray(v.receipts)) cache = cache ? mergeDocs(cache, v) : v;
}
function save(): void {
  const d = load();
  if (d.receipts.length > MAX_RECEIPTS) d.receipts = d.receipts.slice(-MAX_RECEIPTS);
  saveDoc(DOC, d);
}

export function getPolicy(): GuardPolicy {
  const p = load().policy;
  if (p) return p;
  return { ...DEFAULT_POLICY, updatedAt: new Date(0).toISOString(), updatedBy: "default" };
}

/** Admin-only (the route enforces the credential): install a new policy version, signed. The spending agent
 *  can only ever GET this — it cannot author its own cap increase. */
export async function setPolicy(input: Partial<Pick<GuardPolicy, "maxPerTxUsdc" | "maxPerPayeeWindowUsdc" | "windowHours" | "requireSimulation">>): Promise<GuardPolicy> {
  const cur = getPolicy();
  const next: GuardPolicy = {
    version: (cur.version || 0) + 1,
    maxPerTxUsdc: num(input.maxPerTxUsdc, cur.maxPerTxUsdc),
    maxPerPayeeWindowUsdc: num(input.maxPerPayeeWindowUsdc, cur.maxPerPayeeWindowUsdc),
    windowHours: Math.max(1, Math.min(24 * 30, num(input.windowHours, cur.windowHours))),
    requireSimulation: typeof input.requireSimulation === "boolean" ? input.requireSimulation : cur.requireSimulation,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin",
  };
  try {
    const sig = await signReceipt(next);
    if (sig) Object.assign(next, sig);
  } catch {
    /* best-effort */
  }
  next.policyId = verificationId(next);
  const d = load();
  d.policy = next;
  save();
  return next;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

// ---- rolling exposure (anti salami-slicing; keyed per principal so no cross-principal griefing) ------------

function expKey(principal: string, payee: string): string {
  return `${principal}|${payee}`;
}
export function rollingExposure(principal: string, payee: string, windowHours: number, now = Date.now()): number {
  const d = load();
  const k = expKey(principal, payee);
  const cut = now - windowHours * 3600_000;
  const rows = (d.exposure[k] || []).filter((r) => r.at >= cut);
  d.exposure[k] = rows; // prune expired as we read
  return round6(rows.reduce((a, r) => a + r.amount, 0));
}
function addExposure(principal: string, payee: string, amount: number, now = Date.now()): void {
  const d = load();
  (d.exposure[expKey(principal, payee)] ||= []).push({ at: now, amount });
}

// ---- the authorize gate ------------------------------------------------------------------------------------

function newId(): string {
  return BigInt("0x" + randomBytes(8).toString("hex")).toString(36).slice(0, 11);
}

export async function authorize(input: { principal: string; payee: string; amountUsdc: number; now?: number }): Promise<GuardReceipt> {
  const now = input.now ?? Date.now();
  const principal = (input.principal || "anonymous").slice(0, 80);
  const payee = (input.payee || "").trim();
  const amount = round6(Number(input.amountUsdc) || 0);
  const policy = getPolicy();
  const reasons: string[] = [];
  const gates = { frozen: false, compliance: "skipped", policy: "pass", exposure: "pass", simulation: "skipped" };

  if (!payee || !(amount > 0)) {
    reasons.push("invalid request: a payee and a positive amountUsdc are required");
    gates.policy = "invalid";
  }

  // 1) operator kill-switch
  if (isFrozen()) {
    gates.frozen = true;
    reasons.push("operator guard: settlement is frozen (kill-switch)");
  }

  // 2) compliance (fail-closed inside screenAddress: a denylisted/sanctioned payee is DENIED; under the strict
  //    posture MERIT_COMPLIANCE_BLOCK_REVIEW=1, a REVIEW-flagged payee blocks too — same policy as payouts)
  if (payee) {
    try {
      const s = await screenAddress(payee, { sign: false });
      gates.compliance = s.decision;
      const blockReview = process.env.MERIT_COMPLIANCE_BLOCK_REVIEW === "1";
      if (s.decision === "DENIED") reasons.push(`compliance: payee is ${s.riskScore || "denied"}${s.ruleName ? ` (${s.ruleName})` : ""}`);
      else if (s.decision === "REVIEW" && blockReview) reasons.push(`compliance: payee flagged for REVIEW${s.ruleName ? ` (${s.ruleName})` : ""} — blocked under the strict posture`);
    } catch {
      gates.compliance = "error";
      reasons.push("compliance: screening unavailable — failing closed");
    }
  }

  // 3) policy caps (admin-authored; the agent cannot have edited these)
  if (amount > policy.maxPerTxUsdc) {
    gates.policy = "over-cap";
    reasons.push(`policy v${policy.version}: amount ${amount} exceeds maxPerTxUsdc ${policy.maxPerTxUsdc}`);
  }

  // 4) rolling per-counterparty exposure (salami-slicing: many sub-cap payments to one payee)
  const exposed = payee ? rollingExposure(principal, payee, policy.windowHours, now) : 0;
  if (payee && exposed + amount > policy.maxPerPayeeWindowUsdc) {
    gates.exposure = "over-window";
    reasons.push(
      `exposure: ${round6(exposed + amount)} to this payee in ${policy.windowHours}h would exceed maxPerPayeeWindowUsdc ${policy.maxPerPayeeWindowUsdc} (already ${exposed})`,
    );
  }

  // 5) tx-simulation pre-flight (a FAILING sim always blocks; an UNAVAILABLE sim blocks only when required)
  if (payee && amount > 0 && reasons.length === 0) {
    try {
      const sim = await simulateUsdcTransfer({ from: "", to: payee, amount });
      gates.simulation = sim.wouldSucceed ? "pass" : "would-fail";
      if (!sim.wouldSucceed) reasons.push(`simulation: ${sim.reason}`);
    } catch {
      gates.simulation = "unavailable";
      if (policy.requireSimulation) reasons.push("simulation: unavailable and policy requires it");
    }
  }

  const decision: "allow" | "block" = reasons.length === 0 ? "allow" : "block";
  if (decision === "allow") addExposure(principal, payee, amount, now);

  const receipt: GuardReceipt = {
    id: newId(),
    decision,
    principal,
    payee,
    amountUsdc: amount,
    reasons,
    gates,
    policyVersion: policy.version,
    exposureAfterUsdc: payee ? rollingExposure(principal, payee, policy.windowHours, now) : 0,
    createdAt: new Date(now).toISOString(),
  };
  await sign(receipt);
  const d = load();
  d.receipts.push(receipt);
  save(); // persisted BEFORE the caller sees it — the decision and its evidence are the same artifact
  return receipt;
}

/** A human override of a blocked decision: its own signed receipt, chained to the blocked receipt, naming the
 *  operator. It does NOT move money — it records, non-repudiably, who accepted the risk. */
export async function recordOverride(input: { blockedReceiptId: string; operator: string; reason: string }): Promise<GuardReceipt | { error: string; status: number }> {
  const d = load();
  const blocked = d.receipts.find((r) => r.id === input.blockedReceiptId && r.decision === "block");
  if (!blocked) return { error: "no blocked receipt with that id", status: 404 };
  const operator = (input.operator || "").trim();
  if (!operator) return { error: "an override must name the operator", status: 400 };
  const receipt: GuardReceipt = {
    id: newId(),
    decision: "override",
    principal: blocked.principal,
    payee: blocked.payee,
    amountUsdc: blocked.amountUsdc,
    reasons: [`override of ${blocked.id}: ${(input.reason || "no reason given").slice(0, 200)}`],
    gates: blocked.gates,
    policyVersion: blocked.policyVersion,
    exposureAfterUsdc: blocked.exposureAfterUsdc,
    overrides: blocked.id,
    operator: operator.slice(0, 80),
    createdAt: new Date().toISOString(),
  };
  await sign(receipt);
  d.receipts.push(receipt);
  save();
  return receipt;
}

export function listGuardReceipts(limit = 30): GuardReceipt[] {
  const r = load().receipts;
  return r.slice(Math.max(0, r.length - limit)).reverse();
}
export function getGuardReceipt(id: string): GuardReceipt | undefined {
  return load().receipts.find((r) => r.id === id);
}
export function guardStats(): { decisions: number; allowed: number; blocked: number; overrides: number; blockedUsdc: number } {
  const r = load().receipts;
  let blockedUsdc = 0;
  for (const x of r) if (x.decision === "block") blockedUsdc = round6(blockedUsdc + x.amountUsdc);
  return {
    decisions: r.length,
    allowed: r.filter((x) => x.decision === "allow").length,
    blocked: r.filter((x) => x.decision === "block").length,
    overrides: r.filter((x) => x.decision === "override").length,
    blockedUsdc,
  };
}

async function sign(receipt: GuardReceipt): Promise<void> {
  try {
    const signable = { schema: "merit.guard/v1", ...receipt };
    const sig = await signReceipt(signable);
    receipt.schema = "merit.guard/v1";
    if (sig) {
      receipt.signer = sig.signer;
      receipt.signature = sig.signature;
    }
    receipt.receiptId = verificationId({ schema: "merit.guard/v1", id: receipt.id, decision: receipt.decision, payee: receipt.payee, amountUsdc: receipt.amountUsdc, createdAt: receipt.createdAt });
  } catch {
    /* best-effort */
  }
}

/** Test hook. */
export function _resetGuardPlane(): void {
  cache = { policy: null, receipts: [], exposure: {} };
}

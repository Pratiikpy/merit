/**
 * Programmable spend guardrails (#6) — the "bounded authority" buyers explicitly ask for (per the Arc
 * research) instead of unbounded autonomy. A run may carry a `policy`: an allowlist (only these sources are
 * eligible), a per-source cap, a human-approval threshold (a payment above it is HELD, not auto-paid), and a
 * max-refund ratio (stop releasing once refunds blow past a fraction of budget). All pure + unit-tested; the
 * policy is opt-in, so a run without one behaves exactly as before.
 */
export interface RunPolicy {
  allowlist?: string[]; // source ids OR names; empty/undefined = all allowed
  perSourceCap?: number; // max USDC paid to any single source
  approvalThreshold?: number; // a single payout above this is held pending human approval
  maxRefundRatio?: number; // once refunds exceed this fraction of budget, hold further releases
}

/** Parse + sanitize an untrusted policy from a request body. Returns {} for anything malformed. */
export function parsePolicy(raw: unknown): RunPolicy {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const policy: RunPolicy = {};
  if (Array.isArray(r.allowlist)) policy.allowlist = r.allowlist.filter((x) => typeof x === "string").slice(0, 100) as string[];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  if (num(r.perSourceCap) !== undefined) policy.perSourceCap = num(r.perSourceCap);
  if (num(r.approvalThreshold) !== undefined) policy.approvalThreshold = num(r.approvalThreshold);
  const ratio = num(r.maxRefundRatio);
  if (ratio !== undefined) policy.maxRefundRatio = Math.min(1, ratio);
  return policy;
}

/** Is a source allowed by the policy's allowlist? (id or name match; no allowlist = all allowed) */
export function sourceAllowed(policy: RunPolicy, id: string, name: string): boolean {
  const al = policy.allowlist;
  if (!al || al.length === 0) return true;
  const set = al.map((x) => x.toLowerCase());
  return set.includes(id.toLowerCase()) || set.includes(name.toLowerCase());
}

export type HoldReason = { kind: "cap" | "approval" | "refund-ratio"; reason: string } | null;

/** Why (if at all) a release must be HELD instead of paid, per the policy. Checked at settlement time,
 *  after the budget gate. Returns the hold reason, or null to proceed with payment. */
export function releaseHold(policy: RunPolicy, cost: number, refundedSoFar: number, budget: number): HoldReason {
  if (policy.perSourceCap != null && cost > policy.perSourceCap + 1e-9)
    return { kind: "cap", reason: `Per-source cap $${policy.perSourceCap} exceeded ($${cost.toFixed(4)}) — held by policy.` };
  if (policy.approvalThreshold != null && cost > policy.approvalThreshold + 1e-9)
    return { kind: "approval", reason: `Above the $${policy.approvalThreshold} approval threshold — held pending human approval.` };
  if (policy.maxRefundRatio != null && budget > 0 && refundedSoFar / budget > policy.maxRefundRatio + 1e-9)
    return { kind: "refund-ratio", reason: `Refund ratio cap (${Math.round(policy.maxRefundRatio * 100)}%) reached — further releases held.` };
  return null;
}

import { NextResponse } from "next/server";
import { authGate, refreshAuthFromMirror } from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import {
  createPolicy,
  resolvePolicy,
  listPolicies,
  getPolicy,
  insuranceStats,
  refreshInsuranceFromMirror,
  insuranceOnchainEnabled,
  readUnderwriterPool,
  depositUnderwriterPool,
} from "@/lib/insurance";
import { publicOrigin } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120; // create (verify + bind) or resolve (jury panel + arbiter resolve) on-chain

// Agentic insurance — a guarantee market on Merit's OWN verdicts. Buy coverage on a (claim, source) pair;
// Merit's free verifier decides the verdict being insured. Resolve later by re-checking with the PAID jury
// panel — if it disagrees with the original call, that's the verified loss event and coverage pays out.
//
// POST /api/insurance { action: "create",  claim, source, coverageUsdc, premiumUsdc }
// POST /api/insurance { action: "resolve", id }
// POST /api/insurance { action: "fund-pool", amountUsdc }   (admin — tops up the underwriter's on-chain pool)
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) {
    return NextResponse.json(
      { error: rl.status === 429 ? "rate_limited" : "busy", retryAfterMs: rl.retryMs },
      { status: rl.status, headers: { "Retry-After": String(Math.ceil((rl.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { action?: string; claim?: string; source?: string; coverageUsdc?: number; premiumUsdc?: number; id?: string; amountUsdc?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = (body.action || "").trim();

  if (action === "fund-pool") {
    const admin = req.headers.get("x-admin-token");
    if (!admin || admin !== process.env.MERIT_ADMIN_TOKEN) return NextResponse.json({ error: "admin only" }, { status: 401 });
    const res = await depositUnderwriterPool(Number(body.amountUsdc) || 0);
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ deposit: res });
  }

  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  await refreshInsuranceFromMirror().catch(() => {});

  if (action === "create") {
    // The policy's coverage/premium are recorded regardless of auth — a policy with no coverage isn't a
    // policy. Binding it on-chain spends Merit's own BUYER premium and reserves OPERATOR pool capacity
    // though, so ONLY an authenticated principal can trigger that; a public create still gets the full
    // off-chain record, resolvable by the same two verdicts (the free verifier now, the paid jury later).
    const canBind = gate.ok && !!gate.principal;
    const res = await createPolicy({
      claim: body.claim || "",
      source: body.source || "",
      coverageUsdc: Number(body.coverageUsdc) || 0,
      premiumUsdc: Number(body.premiumUsdc) || 0,
      allowOnchain: canBind,
    });
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    const origin = publicOrigin(req);
    return NextResponse.json({
      policy: res.policy,
      shareUrl: `${origin}/insurance.html?id=${res.policy.id}`,
      bindNote: canBind ? undefined : "Recorded off-chain (no real coverage bound). Connect an API key with coverageUsdc + premiumUsdc to bind a real on-chain policy.",
      onchain: insuranceOnchainEnabled(),
    });
  }

  if (action === "resolve") {
    if (!body.id) return NextResponse.json({ error: "provide the policy { id } to resolve" }, { status: 400 });
    const res = await resolvePolicy(body.id);
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({
      policy: res.policy,
      note:
        res.policy.outcome === "paid"
          ? "The paid jury OVERTURNED the original free verdict — that is the verified loss event, and coverage pays the buyer."
          : "The paid jury AGREED with the original free verdict — no loss event, the reservation releases back to the pool.",
    });
  }

  return NextResponse.json({ error: 'provide an { action }: "create" | "resolve"' }, { status: 400 });
}

// GET /api/insurance          → { policies, stats, onchain, pool }
// GET /api/insurance?id=<id>  → { policy }
export async function GET(req: Request) {
  await refreshInsuranceFromMirror().catch(() => {});
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const policy = getPolicy(id);
    if (!policy) return NextResponse.json({ error: "policy not found" }, { status: 404 });
    return NextResponse.json({ policy });
  }
  const pool = process.env.OPERATOR_ADDRESS ? await readUnderwriterPool(process.env.OPERATOR_ADDRESS) : null;
  return NextResponse.json({ policies: listPolicies(40), stats: insuranceStats(), onchain: insuranceOnchainEnabled(), pool });
}

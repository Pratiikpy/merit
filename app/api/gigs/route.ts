import { NextResponse } from "next/server";
import { authGate, refreshAuthFromMirror } from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { postGig, submitToGig, cancelGig, listGigs, getGig, gigStats, refreshGigsFromMirror } from "@/lib/gigs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // grade (LLM) + on-chain ERC-8183 hook lifecycle (7 sequential txs) on an accepted release

// The verified freelance/bounty escrow board — for humans and agents. A poster puts up a brief + requirements +
// a USDC bounty; a worker submits a deliverable; Merit's REAL grader scores it against the requirements and
// releases the escrow only when the work meets them (the evaluator Receipt/Arco/BugBountyAI faked). Grading is
// public (anyone can see the real accept/reject); the actual USDC release only fires for an authenticated
// principal, proven on-chain by the same ERC-8183 gate that settles citations.
//
// POST /api/gigs { action: "post",   title, brief, requirements?, bountyUsdc, poster? }
// POST /api/gigs { action: "submit", gigId, worker?, workerAddress?, deliverable }
// POST /api/gigs { action: "cancel", gigId, poster? }
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) {
    return NextResponse.json(
      { error: rl.status === 429 ? "rate_limited" : "busy", retryAfterMs: rl.retryMs },
      { status: rl.status, headers: { "Retry-After": String(Math.ceil((rl.retryMs ?? 3000) / 1000)) } },
    );
  }

  let body: { action?: string; title?: string; brief?: string; requirements?: string[]; bountyUsdc?: number; poster?: string; gigId?: string; worker?: string; workerAddress?: string; deliverable?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = (body.action || "").trim();

  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  await refreshGigsFromMirror().catch(() => {});

  if (action === "post") {
    const res = postGig({ title: body.title || "", brief: body.brief || "", requirements: body.requirements, bountyUsdc: Number(body.bountyUsdc), poster: (body.poster || gate.principal?.name || "").trim() });
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    const origin = process.env.MERIT_ORIGIN || new URL(req.url).origin;
    return NextResponse.json({ gig: res.gig, shareUrl: `${origin}/gigs.html?id=${res.gig.id}`, note: "Post is live. A worker submits a deliverable; Merit's real grader scores it against the requirements and releases the bounty only if it passes. In this demo Merit custodies the escrow (release = a real claimable payout + an on-chain gate proof); the ERC-8183 MeritJob path lets a real poster fund their own escrow." });
  }

  if (action === "submit") {
    if (!body.gigId) return NextResponse.json({ error: "provide the { gigId } to submit to" }, { status: 400 });
    // The real GRADE runs for anyone; the actual escrow RELEASE (real USDC) only fires for an authenticated
    // principal — a public submission sees the true accept/reject decision but moves no money.
    const settle = gate.ok && !!gate.principal;
    const res = await submitToGig({
      gigId: body.gigId,
      worker: (body.worker || gate.principal?.name || "anonymous").trim(),
      workerAddress: body.workerAddress,
      deliverable: body.deliverable || "",
      settle,
    });
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({
      gig: res.gig,
      submission: res.submission,
      settleNote: settle ? undefined : "Graded in public mode — the accept/reject decision is real; connect an API key (Authorization: Bearer <key>) to release the escrow to a worker.",
    });
  }

  if (action === "cancel") {
    if (!body.gigId) return NextResponse.json({ error: "provide the { gigId } to cancel" }, { status: 400 });
    const res = cancelGig(body.gigId, (body.poster || gate.principal?.name || "").trim());
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ gig: res.gig });
  }

  return NextResponse.json({ error: 'provide an { action }: "post" | "submit" | "cancel"' }, { status: 400 });
}

// GET /api/gigs          → { gigs, stats }
// GET /api/gigs?id=<id>  → { gig }
export async function GET(req: Request) {
  await refreshGigsFromMirror().catch(() => {});
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const gig = getGig(id);
    if (!gig) return NextResponse.json({ error: "gig not found" }, { status: 404 });
    return NextResponse.json({ gig });
  }
  return NextResponse.json({ gigs: listGigs(40), stats: gigStats() });
}

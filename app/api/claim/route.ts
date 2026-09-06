import { NextResponse } from "next/server";
import { normalizeDomain, verifyDomainClaim } from "@/lib/passport";
import { claimCustody, claimCustodyBatch, custodyAddress, custodyByDomain, refreshCustodyFromMirror } from "@/lib/custody";
import { checkChallengeLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // an on-chain USDC transfer + receipt can take tens of seconds

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

// GET /api/claim?domain=<host> — how much a domain's creators can withdraw from Merit custody.
export async function GET(req: Request) {
  await refreshCustodyFromMirror().catch(() => {});
  const domain = normalizeDomain(new URL(req.url).searchParams.get("domain") || "");
  if (!domain) return NextResponse.json({ error: "provide ?domain=<your-domain>" }, { status: 400 });
  const creators = custodyByDomain(domain).map((e) => ({ id: e.id, name: e.name, unclaimed: r6(Math.max(0, e.earned - e.claimed)) }));
  const unclaimed = r6(creators.reduce((s, c) => s + c.unclaimed, 0));
  return NextResponse.json({ domain, unclaimed, creators, custodyWallet: custodyAddress() });
}

// POST /api/claim { domain } — prove control of the domain by hosting /.well-known/merit.json, then Merit
// disburses that domain's accrued custody balance ON-CHAIN to the wallet the merit.json declares. The proof
// IS the authorization: a claim can only ever pay the domain's own published wallet — never one a caller
// passes in — so it can't be used to redirect someone else's earnings.
export async function POST(req: Request) {
  const gate = checkChallengeLimit(Date.now());
  if (!gate.allowed) {
    return NextResponse.json({ error: "busy", retryAfterMs: gate.retryMs }, { status: gate.status, headers: { "Retry-After": String(Math.ceil((gate.retryMs ?? 3000) / 1000)) } });
  }
  let body: { domain?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.domain) return NextResponse.json({ error: "provide { domain }" }, { status: 400 });

  let passport;
  try {
    passport = await verifyDomainClaim(body.domain);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  await refreshCustodyFromMirror().catch(() => {});
  const creators = custodyByDomain(passport.domain);
  if (!creators.length) {
    return NextResponse.json({ error: "no unclaimed earnings are held for this domain", domain: passport.domain }, { status: 404 });
  }

  const claims: Array<Record<string, unknown>> = [];
  let totalClaimed = 0;

  // A domain usually holds more than one balance (the source, plus a `split:` entry per co-author). Pay them in
  // ONE Arc transaction via Multicall3From — one gas fee, one explorer page, and every line still carrying its
  // own memo. All-or-nothing, so a failure leaves every balance untouched and the caller can simply retry.
  if (creators.length > 1) {
    const batch = await claimCustodyBatch(creators.map((c) => c.id), passport.wallet);
    if (batch && !("error" in batch)) {
      return NextResponse.json({
        domain: passport.domain,
        wallet: passport.wallet,
        totalClaimed: batch.total,
        batched: true,
        tx: batch.tx,
        explorerUrl: batch.explorerUrl,
        memoed: batch.memoed,
        memoNote: batch.memoNote,
        memoUrl: batch.memoed ? `/api/memo?tx=${batch.tx}` : null,
        claims: batch.lines.map((l) => ({ id: l.id, name: l.name, ok: true, amount: l.amount, tx: batch.tx, explorerUrl: batch.explorerUrl, memoed: batch.memoed, memoId: l.memoId })),
      });
    }
    // A batch that could not go (compliance, pre-flight, revert) falls through to the per-creator path, which
    // reports each line's own outcome rather than failing the whole claim on one bad line.
  }

  for (const c of creators) {
    const res = await claimCustody(c.id, passport.wallet);
    if ("error" in res) {
      claims.push({ id: c.id, name: c.name, ok: false, error: res.error });
    } else {
      claims.push({
        id: c.id,
        name: c.name,
        ok: true,
        amount: res.amount,
        tx: res.tx,
        explorerUrl: res.explorerUrl,
        // The Arc transaction memo written INSIDE the payment: `memoId` is the bytes32 anyone can use to look
        // this disbursement up by `Memo` event and read which verified work it settled — no Merit server in the
        // loop. `memoNote` is non-null only when the memo could NOT be written, and says why.
        memoed: res.memoed,
        memoId: res.memoId,
        memoNote: res.memoNote,
        memoUrl: res.memoed ? `/api/memo?tx=${res.tx}` : null,
      });
      totalClaimed = r6(totalClaimed + res.amount);
    }
  }
  const anyOk = claims.some((c) => c.ok);
  return NextResponse.json(
    { domain: passport.domain, wallet: passport.wallet, totalClaimed, batched: false, claims },
    { status: anyOk ? 200 : 502 },
  );
}

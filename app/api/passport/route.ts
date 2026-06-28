import { NextRequest, NextResponse } from "next/server";
import { addCreator, setAgentId, publicView, getSources } from "@/lib/registry";
import { registerIdentity } from "@/lib/reputation";
import { looksLikeInjection } from "@/lib/llm";
import { explorerAddr } from "@/lib/arc";
import { verifyDomainClaim } from "@/lib/passport";

export const runtime = "nodejs";

const MAX_CREATORS = 200;
const ORIGIN = process.env.MERIT_ORIGIN || "https://merit-ecru.vercel.app";

// POST /api/passport { domain } — Proof-of-Citation Passport. A creator proves control of their DOMAIN by
// publishing /.well-known/merit.json (their payout wallet + optional name/content). Merit binds domain → wallet
// as an OWNER-VERIFIED creator — the strongest claim a publisher can make, stronger than an edit-the-feed
// marker, and it works for ANY site/CMS. Returns an embeddable, independently-falsifiable verified badge.
export async function POST(req: NextRequest) {
  if (getSources().filter((s) => s.kind === "Creator").length >= MAX_CREATORS) {
    return NextResponse.json({ error: "creator registration is at capacity — try again later" }, { status: 503 });
  }
  let domain = "";
  try {
    domain = String((await req.json())?.domain || "").slice(0, 120);
  } catch {
    /* */
  }
  if (!domain) return NextResponse.json({ error: "domain is required (e.g. yourblog.com)" }, { status: 400 });

  let pass;
  try {
    pass = await verifyDomainClaim(domain);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "domain claim failed" }, { status: 400 });
  }
  if (looksLikeInjection(pass.name) || (pass.content && looksLikeInjection(pass.content))) {
    return NextResponse.json({ error: "rejected — merit.json name/content contains prompt-injection patterns" }, { status: 400 });
  }

  const src = addCreator({ name: pass.name, handle: pass.domain, price: 0.015, priceMode: "merit-gated", wallet: pass.wallet, content: pass.content || undefined });
  const ident = await registerIdentity(`merit:creator:${src.id}`);
  if (ident?.agentId) setAgentId(src.id, ident.agentId);

  const badge = `${ORIGIN}/api/badge?domain=${encodeURIComponent(pass.domain)}`;
  return NextResponse.json({
    ...publicView(src),
    ownerVerified: true, // proven via .well-known domain control — NOT a Merit-generated wallet
    domain: pass.domain,
    wallet: pass.wallet,
    earnable: !!pass.content,
    explorerUrl: explorerAddr(src.wallet),
    agentId: ident?.agentId ?? null,
    badge,
    embed: `<a href="${ORIGIN}/passport.html"><img src="${badge}" alt="Cited by AI — Verified by Merit" height="20"></a>`,
  });
}

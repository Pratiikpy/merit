import { NextRequest, NextResponse } from "next/server";
import { addCreator, setAgentId, publicView, getSources } from "@/lib/registry";
import { registerIdentity } from "@/lib/reputation";
import { looksLikeInjection } from "@/lib/llm";
import { explorerAddr } from "@/lib/arc";
import { fetchFeed, feedContent } from "@/lib/feed";

export const runtime = "nodejs";

// POST /api/creators/from-feed — one-click creator onboarding from an RSS/Atom feed (the distribution wedge):
// fetch the feed, turn the publisher's recent work into citable source text, mint a receive-only wallet (or
// the owner's own, if the feed carries a merit-verify marker), and register an ERC-8004 identity. Same growth
// cap + injection guard as /register; the only new surface is the feed fetch + parse.
const MAX_CREATORS = 200;

export async function POST(req: NextRequest) {
  if (getSources().filter((s) => s.kind === "Creator").length >= MAX_CREATORS) {
    return NextResponse.json({ error: "creator registration is at capacity — try again later" }, { status: 503 });
  }

  let feedUrl = "";
  let price = 0.015;
  let priceMode: "fixed" | "merit-gated" = "fixed";
  try {
    const body = await req.json();
    feedUrl = String(body?.feedUrl ?? body?.url ?? "").slice(0, 300);
    if (body?.price != null) {
      const p = Number(body.price);
      if (Number.isFinite(p)) price = Math.min(1, Math.max(0.0001, p));
    }
    if (body?.priceMode === "merit-gated") priceMode = "merit-gated";
  } catch {
    /* defaults */
  }
  if (!feedUrl) return NextResponse.json({ error: "feedUrl is required" }, { status: 400 });

  let feed;
  try {
    feed = await fetchFeed(feedUrl);
  } catch (e) {
    return NextResponse.json({ error: `couldn't onboard that feed — ${e instanceof Error ? e.message : "fetch failed"}` }, { status: 400 });
  }

  const name = feed.title;
  const content = feedContent(feed);
  // Same door-guard as /register: the feed's title + text become the prose the writer LLM reads, so an injected
  // feed never enters the pool. Plain headlines + prose never trip it.
  if (looksLikeInjection(name) || (content && looksLikeInjection(content))) {
    return NextResponse.json({ error: "rejected — the feed's title or content contains prompt-injection patterns" }, { status: 400 });
  }

  // Live-web (#9 + Agent-Reach web channel): re-read the publisher's real page fresh each run via Jina, so a
  // citation is verified against their ACTUAL current content — not a stale onboarding snapshot. The static
  // feed content stays as the graceful fallback when the live fetch is unavailable (MERIT_LIVE_WEB=0 / offline).
  const src = addCreator({
    name, handle: feed.link, price, priceMode, wallet: feed.verifyWallet,
    content: content || undefined,
    provider: feed.link ? "jina" : undefined,
    url: feed.link || undefined,
  });
  const ident = await registerIdentity(`merit:creator:${src.id}`);
  if (ident?.agentId) setAgentId(src.id, ident.agentId);

  return NextResponse.json({
    ...publicView(src),
    balance: 0,
    ownerVerified: !!feed.verifyWallet, // true = the feed proved ownership (merit-verify marker) → payouts go to the owner's wallet
    earnable: !!content, // has citable content → can actually be cited + paid
    entries: feed.entries.length,
    feedTitle: feed.title,
    explorerUrl: explorerAddr(src.wallet),
    agentId: ident?.agentId ?? null,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { addCreator, setAgentId, publicView, getSources } from "@/lib/registry";
import { registerIdentity } from "@/lib/reputation";
import { looksLikeInjection } from "@/lib/llm";
import { explorerAddr } from "@/lib/arc";

export const runtime = "nodejs";

// POST /api/creators/register — onboard a creator: generate an EOA receiving
// wallet, add to the registry, best-effort mint an ERC-8004 identity.
// Bound registry growth: the register endpoint is unauthenticated, so cap the
// number of registered creators to prevent flooding the source pool the agent
// iterates each run. (Discovered sources are separately capped in the registry.)
const MAX_CREATORS = 200;

export async function POST(req: NextRequest) {
  if (getSources().filter((s) => s.kind === "Creator").length >= MAX_CREATORS) {
    return NextResponse.json(
      { error: "creator registration is at capacity — try again later" },
      { status: 503 },
    );
  }

  let name = "Anonymous Creator";
  let url = "";
  let price = 0.015;
  let priceMode: "fixed" | "merit-gated" = "fixed"; // #4: creators self-price (let reputation set the premium)
  let provider: string | undefined; // #9: pay-per-call — "fixture" fetches content live (the keyless tested path)
  let verifyWith: string[] | undefined; // #10: extra verification adapters this source must pass
  let wallet = "";
  let content = "";
  try {
    const body = await req.json();
    if (body?.name) name = String(body.name).slice(0, 80);
    if (body?.url) url = String(body.url).slice(0, 200);
    // Floor prevents zero/negative; ceiling stops an inflated price from skewing
    // the escrow display or monopolizing a run's budget. (Use isFinite, not `|| default`,
    // so a real 0 is floored to the minimum rather than bounced to the default.)
    if (body?.price != null) {
      const p = Number(body.price);
      if (Number.isFinite(p)) price = Math.min(1, Math.max(0.0001, p));
    }
    if (body?.priceMode === "merit-gated") priceMode = "merit-gated";
    if (body?.provider === "fixture") provider = "fixture"; // only the keyless fixture is settable via the API
    if (Array.isArray(body?.verifyWith)) {
      const known = ["numeric", "schema", "freshness", "nonempty"];
      const v = (body.verifyWith as unknown[]).filter((x): x is string => typeof x === "string" && known.includes(x)).slice(0, 6);
      if (v.length) verifyWith = v;
    }
    const w = body?.wallet ? String(body.wallet) : "";
    // Valid 40-hex address, but never the zero address (settling there burns funds).
    if (/^0x[0-9a-fA-F]{40}$/.test(w) && !/^0x0+$/i.test(w)) wallet = w;
    // What the agent reads + cites — without it the creator can't be cited or paid.
    if (body?.content) content = String(body.content).slice(0, 2000);
  } catch {
    /* defaults */
  }

  // The name + content are exactly the text the writer LLM later reads (`from <name>` + the cited
  // passage), so guard them at the door with the same injection check used at citation-verify time —
  // injected source text never enters the pool. Plain creator names + source prose never trip it.
  if (looksLikeInjection(name) || (content && looksLikeInjection(content))) {
    return NextResponse.json(
      { error: "rejected — the name or content contains prompt-injection patterns; submit plain text" },
      { status: 400 },
    );
  }

  const src = addCreator({ name, handle: url, price, priceMode, provider, verifyWith, wallet: wallet || undefined, content: content || undefined });
  const ownWallet = !!wallet;
  const earnable = !!content; // has citable content → eligible to be cited + paid

  // Best-effort on-chain identity (no-op unless REPUTATION_ONCHAIN=1; stubbed otherwise).
  const ident = await registerIdentity(`merit:creator:${src.id}`);
  if (ident?.agentId) setAgentId(src.id, ident.agentId);

  return NextResponse.json({
    ...publicView(src),
    balance: 0,
    ownWallet, // true = paid to the creator's own wallet (non-custodial)
    earnable, // true = provided citable content, so the agent can actually pay them
    explorerUrl: explorerAddr(src.wallet),
    agentId: ident?.agentId ?? null,
  });
}

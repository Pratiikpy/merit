import { NextResponse } from "next/server";
import { authGate, refreshAuthFromMirror } from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { registerMedia, licenseMedia, listMedia, getMedia, listLicenses, mediaStats, refreshMediaFromMirror } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120; // provenance verify (LLM) + on-chain hook lifecycle on a verified license release

// Provenance-verified media licensing — extends the moat to a new modality. A seller lists media (title +
// description + transcript); a buyer requests media for a need; Merit's verifier checks the media's own
// provenance genuinely supports the request before any USDC moves. You never license media that isn't what it
// claims. Verifying the match is public; the actual license-fee release only fires for an authenticated principal.
//
// POST /api/media { action: "register", title, description, transcript?, url?, mediaType?, owner?, ownerAddress?, priceUsdc, attestation? }
// POST /api/media { action: "license",  mediaId, request, buyer? }
export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) {
    return NextResponse.json(
      { error: rl.status === 429 ? "rate_limited" : "busy", retryAfterMs: rl.retryMs },
      { status: rl.status, headers: { "Retry-After": String(Math.ceil((rl.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { action?: string; title?: string; description?: string; transcript?: string; url?: string; mediaType?: string; owner?: string; ownerAddress?: string; priceUsdc?: number; attestation?: string; mediaId?: string; request?: string; buyer?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = (body.action || "").trim();

  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  await refreshMediaFromMirror().catch(() => {});

  if (action === "register") {
    const res = registerMedia({ title: body.title || "", description: body.description || "", transcript: body.transcript, url: body.url, mediaType: body.mediaType, owner: (body.owner || gate.principal?.name || "").trim(), ownerAddress: body.ownerAddress, priceUsdc: Number(body.priceUsdc), attestation: body.attestation });
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ media: res.media, note: "Listed. A buyer requests media for a need; Merit verifies this item's provenance supports the request before any payment." });
  }

  if (action === "license") {
    if (!body.mediaId) return NextResponse.json({ error: "provide the { mediaId } to license" }, { status: 400 });
    const settle = gate.ok && !!gate.principal;
    const res = await licenseMedia({ mediaId: body.mediaId, request: body.request || "", buyer: (body.buyer || gate.principal?.name || "anonymous").trim(), settle });
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({
      license: res.license,
      settleNote: settle ? undefined : "Verified in public mode — the match decision is real; connect an API key (Authorization: Bearer <key>) to release the license fee to the owner.",
    });
  }

  return NextResponse.json({ error: 'provide an { action }: "register" | "license"' }, { status: 400 });
}

// GET /api/media          → { media, licenses, stats }
// GET /api/media?id=<id>  → { media }
export async function GET(req: Request) {
  await refreshMediaFromMirror().catch(() => {});
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const media = getMedia(id);
    if (!media) return NextResponse.json({ error: "media not found" }, { status: 404 });
    return NextResponse.json({ media });
  }
  return NextResponse.json({ media: listMedia(40), licenses: listLicenses(30), stats: mediaStats() });
}

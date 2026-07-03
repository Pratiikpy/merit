import { NextResponse } from "next/server";
import { getCard, refreshCardsFromMirror, signedReceipt } from "@/lib/cards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/card/[id] — fetch one shareable verification receipt (for the /v/[id] page + third-party embeds).
// `signed` is the EXACT object the verifier signed: pipe it to scripts/verify-receipt.mjs (or recover the
// signer from canonicalize(signed minus signer/signature)) to confirm the verdict offline, trusting no server.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await refreshCardsFromMirror().catch(() => {});
  const card = getCard(id);
  if (!card) return NextResponse.json({ error: "receipt not found" }, { status: 404 });
  return NextResponse.json({ ...card, signed: signedReceipt(card) }, { headers: { "Cache-Control": "public, max-age=60" } });
}

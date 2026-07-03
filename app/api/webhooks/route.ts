import { NextResponse } from "next/server";
import { authGate , refreshAuthFromMirror} from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { listWebhooks, refreshWebhooksFromMirror, registerWebhook, removeWebhook } from "@/lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/webhooks — list this principal's registered webhook endpoints (never returns the secret).
export async function GET(req: Request) {
  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  await refreshWebhooksFromMirror().catch(() => {});
  return NextResponse.json({ webhooks: listWebhooks(gate.principal?.id) });
}

// POST /api/webhooks { url, events? } — register a webhook that receives SIGNED settlement/verification events.
// The secret is returned ONCE (derived, never stored). The URL is SSRF-validated (no localhost/private/IPv6-loopback).
export async function POST(req: Request) {
  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) return NextResponse.json({ error: "busy — try again in a moment" }, { status: rl.status });

  let body: { url?: string; events?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const url = (body.url || "").trim();
  if (!url) return NextResponse.json({ error: "provide a { url } to receive events" }, { status: 400 });

  try {
    await refreshWebhooksFromMirror().catch(() => {});
    const wh = await registerWebhook(url, { principalId: gate.principal?.id, events: body.events });
    return NextResponse.json({
      id: wh.id,
      url: wh.url,
      secret: wh.secret, // shown ONCE — store it; verify each delivery's Merit-Signature header with it
      note: "Verify each delivery: HMAC-SHA256(secret, `${t}.${rawBody}`) must equal the v1 in the Merit-Signature header (t=<unix>,v1=<hex>).",
      events: body.events?.length ? body.events : ["*"],
    });
  } catch (e) {
    // assertPublicUrl / URL parse failures land here — treat as a bad target, not a server error.
    return NextResponse.json({ error: `that URL isn't allowed (${(e as Error).message.slice(0, 80)})` }, { status: 400 });
  }
}

// DELETE /api/webhooks?id=wh_… — remove one of this principal's webhooks.
export async function DELETE(req: Request) {
  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "provide ?id=<webhook id>" }, { status: 400 });
  await refreshWebhooksFromMirror().catch(() => {});
  const removed = removeWebhook(id, gate.principal?.id);
  if (!removed) return NextResponse.json({ error: "unknown webhook (or not yours)" }, { status: 404 });
  return NextResponse.json({ removed: true, id });
}

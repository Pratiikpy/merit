import { NextResponse } from "next/server";
import { freeze, guardStatus, refreshGuardFromMirror, unfreeze } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The operator kill-switch. Gated by MERIT_ADMIN_TOKEN (X-Admin-Token header) — disabled unless the token is set,
// so no one can freeze/thaw a default deploy. GET → the live guard status (freeze state, daily cap, velocity).
function adminOk(req: Request): boolean {
  const token = process.env.MERIT_ADMIN_TOKEN;
  if (!token) return false;
  return (req.headers.get("x-admin-token") || "") === token;
}

export async function GET(req: Request) {
  if (!adminOk(req)) return NextResponse.json({ error: "admin disabled or unauthorized" }, { status: 403 });
  await refreshGuardFromMirror().catch(() => {});
  return NextResponse.json(guardStatus(Date.now()));
}

// POST { action: "freeze" | "unfreeze", reason? } — the one-call operator freeze / thaw of ALL real settlement.
export async function POST(req: Request) {
  if (!adminOk(req)) return NextResponse.json({ error: "admin disabled or unauthorized" }, { status: 403 });
  let body: { action?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  await refreshGuardFromMirror().catch(() => {});
  if (body.action === "freeze") {
    freeze((body.reason || "").trim() || "operator freeze", "operator");
    return NextResponse.json({ ok: true, ...guardStatus(Date.now()) });
  }
  if (body.action === "unfreeze") {
    unfreeze("operator");
    return NextResponse.json({ ok: true, ...guardStatus(Date.now()) });
  }
  return NextResponse.json({ error: 'provide { action: "freeze" | "unfreeze", reason? }' }, { status: 400 });
}

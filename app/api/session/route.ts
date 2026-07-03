import { NextResponse } from "next/server";
import { authGate, keyFromRequest } from "@/lib/auth";
import { issueSession, isSessionKey, listSessions, revokeSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A session key belongs to a PARENT principal — resolve it, or 401. A session key itself can't mint sessions.
function parentOr401(req: Request) {
  if (isSessionKey(keyFromRequest(req))) return { error: "a session key cannot mint sessions — use the parent API key", status: 403 } as const;
  const gate = authGate(req);
  if (!gate.ok) return { error: gate.error, status: gate.status } as const;
  if (!gate.principal) return { error: "issuing a session requires an API key (Authorization: Bearer <key>)", status: 401 } as const;
  return { principal: gate.principal } as const;
}

// GET /api/session — list this principal's session keys.
export async function GET(req: Request) {
  const g = parentOr401(req);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  return NextResponse.json({ sessions: listSessions(g.principal.id) });
}

// POST /api/session { cap, ttlHours?, label? } — mint a verify-bound session key: it can ONLY spend this
// principal's prepaid balance through POST /api/verify/balance, up to `cap` USDC, until it expires. It cannot
// withdraw, deposit, or move funds any other way.
export async function POST(req: Request) {
  const g = parentOr401(req);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  let body: { cap?: number; ttlHours?: number; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const cap = Number(body.cap);
  if (!Number.isFinite(cap) || cap <= 0) return NextResponse.json({ error: "provide a positive { cap } (USDC this session may spend)" }, { status: 400 });
  const ttlMs = (Number.isFinite(Number(body.ttlHours)) && Number(body.ttlHours) > 0 ? Number(body.ttlHours) : 24) * 60 * 60 * 1000;
  const s = issueSession(g.principal.id, { cap, ttlMs, label: body.label });
  return NextResponse.json({
    ok: true,
    sessionKey: s.sessionKey, // shown ONCE — send as 'Authorization: Bearer <sessionKey>' to POST /api/verify/balance
    id: s.id,
    cap: s.cap,
    expiresAt: new Date(s.expiresAt).toISOString(),
    scope: "verify-only — spends the prepaid balance ONLY on citations that verify; cannot withdraw/deposit",
  });
}

// DELETE /api/session?id=sess_… — revoke a session key immediately.
export async function DELETE(req: Request) {
  const g = parentOr401(req);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "provide ?id=<session id>" }, { status: 400 });
  return NextResponse.json({ revoked: revokeSession(id, g.principal.id), id });
}

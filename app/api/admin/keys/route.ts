import { NextResponse } from "next/server";
import { createApiKey, listPrincipals } from "@/lib/auth";
import { deriveWallet } from "@/lib/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin key management (W2.1). Gated by MERIT_ADMIN_TOKEN (the X-Admin-Token header). DISABLED unless that
// env is set — so no one can mint keys on a default deploy. POST {name, budgetCap} → mints a key (shown
// ONCE). GET → lists principals (never key hashes).
function adminOk(req: Request): boolean {
  const token = process.env.MERIT_ADMIN_TOKEN;
  if (!token) return false; // admin surface stays closed until a token is configured
  return (req.headers.get("x-admin-token") || "") === token;
}

export async function POST(req: Request) {
  if (!adminOk(req)) return NextResponse.json({ error: "admin disabled or unauthorized" }, { status: 403 });
  let body: { name?: string; budgetCap?: number };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const name = String(body.name || "").slice(0, 80) || "agent";
  const budgetCap = Number.isFinite(Number(body.budgetCap)) ? Math.max(0, Number(body.budgetCap)) : 0;
  const { key, principal } = createApiKey(name, budgetCap);
  const wallet = deriveWallet(principal.id); // this principal's own deposit address (W2.2 — no shared EOA)
  return NextResponse.json({
    key, // shown ONCE — store it now; only its hash is kept server-side
    principal: { id: principal.id, name: principal.name, budgetCap: principal.budgetCap },
    wallet: { address: wallet.address, mode: wallet.mode },
    note: "Send as 'Authorization: Bearer <key>' on /api/run. budgetCap 0 = unlimited. Fund the wallet address to spend.",
  });
}

export async function GET(req: Request) {
  if (!adminOk(req)) return NextResponse.json({ error: "admin disabled or unauthorized" }, { status: 403 });
  return NextResponse.json({ principals: listPrincipals() });
}

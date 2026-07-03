import { NextResponse } from "next/server";
import { refreshSellersFromMirror, sellersList, setSellerBlock, sellerHost } from "@/lib/sellers";
import { ephemeralStore, hydrateDoc } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sellers — the outbound-seller reputation ledger + firewall status. Each seller's verified-delivery
// rate over Merit's procurements; a seller below the bar (or operator-blocked) is FIREWALLED — Merit won't pay
// it. Public read-only transparency (a quality signal a pay-on-retrieval buyer can't produce).
export async function GET() {
  if (ephemeralStore()) await hydrateDoc("sellers").catch(() => false);
  await refreshSellersFromMirror().catch(() => {});
  return NextResponse.json({
    schema: "merit.sellers/v1",
    note: "Merit verifies what it procures and firewalls sellers that keep delivering content that doesn't support the claim — verify the work, not the worker.",
    sellers: sellersList(),
  });
}

// POST /api/sellers { host, blocked } — operator hard-block / unblock a seller (admin-gated).
export async function POST(req: Request) {
  const token = process.env.MERIT_ADMIN_TOKEN;
  if (!token || (req.headers.get("x-admin-token") || "") !== token) {
    return NextResponse.json({ error: "admin disabled or unauthorized" }, { status: 403 });
  }
  let body: { host?: string; blocked?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const host = sellerHost((body.host || "").trim());
  if (!host) return NextResponse.json({ error: "provide a { host }" }, { status: 400 });
  await refreshSellersFromMirror().catch(() => {});
  setSellerBlock(host, body.blocked !== false);
  return NextResponse.json({ ok: true, host, blocked: body.blocked !== false });
}

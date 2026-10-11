import { NextResponse } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { authGate, refreshAuthFromMirror } from "@/lib/auth";
import { checkChallengeLimit } from "@/lib/ratelimit";
import { treasuryAddress, readTreasuryBalance } from "@/lib/treasury";
import { eurcEnabled, eurcAddress, readEurcBalance, liveUsdToEurRate, payInEurc, listEurcPayouts, eurcPayoutStats, refreshEurcFromMirror } from "@/lib/eurc";
import { stablefxEnabled, stablefxConfig, getQuote, convertUsdcToEurc } from "@/lib/stablefx";
import { getSource, setPayoutCurrency, refreshRegistryFromMirror } from "@/lib/registry";
import { isStub } from "@/lib/arc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Global verified payouts — pay creators in EURC (real, live, today) and convert treasury surplus via
// Circle's StableFX RFQ exchange (real, code-complete, waiting on a Circle-issued API key).
//
// POST { action: "set-currency", sourceId, currency }         (authenticated — a creator's own setting)
// POST { action: "pay", sourceId, usdcOwed }                  (authenticated — spends real treasury USDC)
// POST { action: "fx-quote", fromAmountUsdc }                 (public preview — honest if unconfigured)
// POST { action: "fx-convert", fromAmountUsdc }                (admin — real treasury-level conversion)
function buyer() {
  const pk = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) throw new Error("BUYER_PRIVATE_KEY not configured");
  return privateKeyToAccount(pk);
}

export async function POST(req: Request) {
  const rl = checkChallengeLimit(Date.now());
  if (!rl.allowed) {
    return NextResponse.json(
      { error: rl.status === 429 ? "rate_limited" : "busy", retryAfterMs: rl.retryMs },
      { status: rl.status, headers: { "Retry-After": String(Math.ceil((rl.retryMs ?? 3000) / 1000)) } },
    );
  }
  let body: { action?: string; sourceId?: string; currency?: string; usdcOwed?: number; fromAmountUsdc?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = (body.action || "").trim();

  if (action === "fx-quote") {
    if (!stablefxEnabled()) {
      return NextResponse.json({ error: "StableFX is not configured — it requires an API key issued directly by a Circle representative (sales@circle.com); there is no self-serve signup. The integration is code-complete and will activate the moment a key is supplied.", config: stablefxConfig() }, { status: 503 });
    }
    const amt = Number(body.fromAmountUsdc) || 0;
    try {
      const quote = await getQuote({ fromAmountUsdc: amt });
      return NextResponse.json({ quote });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 502 });
    }
  }

  await refreshAuthFromMirror().catch(() => {});
  const gate = authGate(req);
  await refreshRegistryFromMirror().catch(() => {});

  if (action === "set-currency") {
    if (!gate.ok) return NextResponse.json({ error: "authenticate with an API key" }, { status: 401 });
    if (!body.sourceId || (body.currency !== "USDC" && body.currency !== "EURC")) {
      return NextResponse.json({ error: 'provide { sourceId, currency: "USDC" | "EURC" }' }, { status: 400 });
    }
    const res = setPayoutCurrency(body.sourceId, body.currency);
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: 404 });
    return NextResponse.json({ source: { id: res.id, name: res.name, payoutCurrency: res.payoutCurrency || "USDC" } });
  }

  if (action === "pay") {
    if (!gate.ok) return NextResponse.json({ error: "a payout spends real treasury USDC — authenticate with an API key" }, { status: 401 });
    if (!body.sourceId) return NextResponse.json({ error: "provide { sourceId, usdcOwed }" }, { status: 400 });
    const source = getSource(body.sourceId);
    if (!source) return NextResponse.json({ error: "unknown source" }, { status: 404 });
    if (source.payoutCurrency !== "EURC") return NextResponse.json({ error: "this source is not set to payoutCurrency EURC" }, { status: 409 });
    await refreshEurcFromMirror().catch(() => {});
    let account;
    try {
      account = buyer();
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 503 });
    }
    const res = await payInEurc({ account, sourceId: source.id, sourceName: source.name, wallet: source.wallet, usdcOwed: Number(body.usdcOwed) || 0 });
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ payout: res.payout });
  }

  if (action === "fx-convert") {
    const admin = req.headers.get("x-admin-token");
    if (!admin || admin !== process.env.MERIT_ADMIN_TOKEN) return NextResponse.json({ error: "admin only — this converts real treasury USDC" }, { status: 401 });
    if (!stablefxEnabled()) {
      return NextResponse.json({ error: "StableFX is not configured — set STABLEFX_API_KEY (from a Circle representative). Code path is complete and untested-in-production pending that key.", config: stablefxConfig() }, { status: 503 });
    }
    const amt = Number(body.fromAmountUsdc) || 0;
    const addr = treasuryAddress();
    if (!addr) return NextResponse.json({ error: "BUYER_ADDRESS (treasury) not configured" }, { status: 503 });
    let account;
    try {
      account = buyer();
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 503 });
    }
    try {
      const result = await convertUsdcToEurc({ account, recipientAddress: addr as `0x${string}`, fromAmountUsdc: amt });
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 502 });
    }
  }

  return NextResponse.json({ error: 'provide an { action }: "set-currency" | "pay" | "fx-quote" | "fx-convert"' }, { status: 400 });
}

// GET /api/payouts                → overview: EURC config, StableFX config, treasury, recent payouts
// GET /api/payouts?sourceId=<id>  → a source's payout currency + live EURC balance
export async function GET(req: Request) {
  await refreshEurcFromMirror().catch(() => {});
  const url = new URL(req.url);
  const sourceId = url.searchParams.get("sourceId");
  if (sourceId) {
    await refreshRegistryFromMirror().catch(() => {});
    const source = getSource(sourceId);
    if (!source) return NextResponse.json({ error: "unknown source" }, { status: 404 });
    const eurcBalance = await readEurcBalance(source.wallet);
    return NextResponse.json({ source: { id: source.id, name: source.name, wallet: source.wallet, payoutCurrency: source.payoutCurrency || "USDC", eurcBalance } });
  }

  let rate = null;
  try {
    rate = await liveUsdToEurRate();
  } catch {
    rate = null;
  }
  return NextResponse.json({
    eurc: { enabled: eurcEnabled(), address: eurcAddress(), rate },
    stablefx: stablefxConfig(),
    treasury: { address: treasuryAddress(), usdcBalance: await readTreasuryBalance() },
    payouts: listEurcPayouts(40),
    stats: eurcPayoutStats(),
    stub: isStub(),
  });
}

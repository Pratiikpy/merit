import { NextResponse } from "next/server";
import { createApiKeyDurable } from "@/lib/auth";
import { provisionWallet, walletMode, circleDcwConfigured, walletSeedConfigured } from "@/lib/wallet";
import { depositAddressFor } from "@/lib/balance";
import { isStub } from "@/lib/arc";
import { checkChallengeLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/onboard/wallet { email? } — wallet-OPTIONAL onboarding for the paying side (Wave D #13). A new user
// gets an account + a wallet without touching a seed phrase: a managed Circle wallet when configured
// (MERIT_WALLET=circle-dcw + Circle keys — the Circle User/Developer-Controlled-Wallet path), else a
// deterministically-derived EOA. Returns an API key + the wallet, so they can fund a prepaid balance and pay
// only for citations that verify. Rate-limited + bounded to a small budget cap so a public endpoint can't be
// farmed. NOTE: a full social-login (OAuth) front-end + Circle's device SDK is the production wrapper on top of
// this server provisioning; that flow is the operator's to wire, and this endpoint is what it plugs into.
export async function POST(req: Request) {
  const gate = checkChallengeLimit(Date.now());
  if (!gate.allowed) return NextResponse.json({ error: "busy — try again in a moment" }, { status: gate.status });

  let body: { email?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const label = ((body.email || body.name || "").trim() || "web-user").slice(0, 80);

  const cap = Number(process.env.MERIT_ONBOARD_CAP);
  const budgetCap = Number.isFinite(cap) && cap > 0 ? cap : 1; // bound a self-serve principal (default $1)
  // Durable mint: an AWAITED authoritative read → union → write (read-your-writes), so rapid self-serve
  // onboarding can never clobber a just-minted key out of the shared mirror (the observed 401-forever drop).
  const { key, principal } = await createApiKeyDurable(label, budgetCap);

  let wallet: { address: string | null; mode: string };
  let managed = false;
  try {
    const w = await provisionWallet(principal.id, label);
    wallet = { address: w.address, mode: w.mode };
    managed = w.mode === "circle-dcw"; // a managed Circle wallet custodies deposits safely regardless of the seed
  } catch (e) {
    // circle-dcw selected but unconfigured, etc. — fall back to the deterministic deposit address (never fail onboarding).
    wallet = { address: depositAddressFor(principal.id), mode: "eoa" };
    console.error("[onboard] wallet provisioning fell back to derived EOA:", (e as Error).message);
  }

  // Only advertise a fundable deposit address when it's safe: a managed Circle wallet, or a derived EOA backed by
  // a REAL seed (or stub/demo). On a live deploy without MERIT_WALLET_SEED the derived EOA uses the PUBLIC dev
  // seed — anyone could sweep it — so we withhold the address and say deposits aren't enabled, rather than invite
  // a deposit that could be stolen.
  const depositReady = managed || isStub() || walletSeedConfigured();
  if (!depositReady && wallet.mode === "eoa") wallet = { address: null, mode: "eoa" };

  return NextResponse.json({
    ok: true,
    apiKey: key, // shown ONCE — send as 'Authorization: Bearer <key>'
    principal: { id: principal.id, name: principal.name, budgetCap },
    wallet, // mode 'circle-dcw' = a managed Circle wallet; 'eoa' = a derived address (null when deposits aren't enabled)
    walletProvider: walletMode(),
    managedWalletsConfigured: circleDcwConfigured(),
    depositsEnabled: depositReady,
    next: depositReady
      ? {
          balance: "GET /api/balance (Authorization: Bearer <key>) — see your prepaid balance + deposit address",
          fund: 'POST /api/balance { action:"deposit", txHash } after sending USDC to your deposit address',
          verify: 'POST /api/verify/balance { claim, source } — billed only for citations that verify',
        }
      : {
          note: "deposits are not enabled on this deployment (no managed wallet + MERIT_WALLET_SEED unset), so no deposit address is issued — your API key and budget cap are live for stub/demo verification",
          verify: 'POST /api/verify/balance { claim, source } — billed only for citations that verify',
        },
  });
}

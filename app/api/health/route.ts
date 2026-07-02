import { NextResponse } from "next/server";
import { ARC, isStub, llmConfig } from "@/lib/arc";
import { getSources } from "@/lib/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health — deployment status + verifiable on-chain references (public
// addresses only, never keys). Doubles as the host health check.
export async function GET() {
  const c = llmConfig();
  return NextResponse.json({
    ok: true,
    product: "Merit",
    mode: isStub() ? "stub" : "live",
    chain: ARC.chainId,
    network: ARC.network,
    sources: getSources().length,
    reputationOnchain: process.env.REPUTATION_ONCHAIN === "1",
    llm: {
      provider: c.isNvidia ? "nvidia" : c.usable ? "openai" : "offline",
      model: c.usable ? c.model : null,
    },
    wallets: {
      buyer: process.env.BUYER_ADDRESS ?? null,
      operator: process.env.OPERATOR_ADDRESS ?? null,
      // KMS-custodied Circle Developer-Controlled Wallet (no plaintext key) when configured
      provider: process.env.CIRCLE_API_KEY ? "circle-dcw" : "eoa",
      circleDcw: process.env.MERIT_DCW_WALLET_ADDRESS ?? null,
    },
    contracts: {
      usdc: ARC.usdc,
      gateway: ARC.gatewayWallet,
      identityRegistry: ARC.identityRegistry,
      reputationRegistry: ARC.reputationRegistry,
    },
    explorer: ARC.explorer,
  });
}

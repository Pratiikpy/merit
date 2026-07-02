import { NextResponse } from "next/server";
import { ARC, isStub, llmConfig } from "@/lib/arc";
import { getSources } from "@/lib/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health — deployment status + verifiable on-chain references (public
// addresses only, never keys). Doubles as the host health check.
export async function GET(req: Request) {
  // TEMP diagnostic: ?llmprobe=1 makes ONE raw LLM call from this serverless function and reports the exact
  // status/error, to distinguish "prod can't reach the LLM provider" from an env problem. Exposes no secret
  // (only key length + the "nvapi-" prefix). Remove after diagnosing.
  if (new URL(req.url).searchParams.get("llmprobe") === "1") {
    const c = llmConfig();
    const t0 = Date.now();
    try {
      const r = await fetch(`${c.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${c.key}` },
        body: JSON.stringify({ model: c.model, messages: [{ role: "user", content: "ok" }], max_tokens: 1, stream: false }),
        signal: AbortSignal.timeout(30000),
      });
      return NextResponse.json({ probe: true, usable: c.usable, keyLen: c.key.length, keyPrefix: c.key.slice(0, 6), baseUrl: c.baseUrl, model: c.model, status: r.status, latencyMs: Date.now() - t0, body: (await r.text()).slice(0, 300) });
    } catch (e) {
      return NextResponse.json({ probe: true, usable: c.usable, keyLen: c.key.length, keyPrefix: c.key.slice(0, 6), baseUrl: c.baseUrl, model: c.model, error: (e as Error).message, latencyMs: Date.now() - t0 });
    }
  }
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

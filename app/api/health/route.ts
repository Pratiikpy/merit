import { NextResponse } from "next/server";
import { ARC, isStub, llmConfig } from "@/lib/arc";
import { getSources } from "@/lib/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health — deployment status + verifiable on-chain references (public
// addresses only, never keys). Doubles as the host health check.
export async function GET(req: Request) {
  // TEMP: ?judgeprobe=1 replays the exact judge-style call from this serverless fn to see status/finish/content.
  if (new URL(req.url).searchParams.get("judgeprobe") === "1") {
    const c = llmConfig();
    const t0 = Date.now();
    try {
      const r = await fetch(`${c.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${c.key}` },
        body: JSON.stringify({ model: c.model, messages: [{ role: "system", content: "You are a strict citation judge. Output ONLY JSON {\"refuted\":boolean,\"reason\":string}." }, { role: "user", content: "CLAIM: The Eiffel Tower is in Paris.\nSOURCE: The Eiffel Tower is a tower in Paris, France." }], max_tokens: 700, temperature: 0.2, stream: false }),
        signal: AbortSignal.timeout(45000),
      });
      const j = await r.json();
      return NextResponse.json({ probe: "judge", status: r.status, latencyMs: Date.now() - t0, finish: j?.choices?.[0]?.finish_reason ?? null, content: (j?.choices?.[0]?.message?.content ?? "").slice(0, 200), err: j?.error ?? null });
    } catch (e) {
      return NextResponse.json({ probe: "judge", error: (e as Error).name + ": " + (e as Error).message, latencyMs: Date.now() - t0 });
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

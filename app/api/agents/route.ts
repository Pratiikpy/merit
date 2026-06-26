import { NextResponse } from "next/server";
import { getSpecialists, specialistView } from "@/lib/specialists";
import { ARC } from "@/lib/arc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/agents — the specialist-agent marketplace directory (the labor supply
// side of the market). Lists every hireable specialist with its role, price,
// reputation, wallet, and x402 endpoints — so any external agent can BROWSE the
// market, pick by reputation/price, and hire one directly (see `npm run external-hire`).
// The creator/content supply lives at /api/sources; this is its agent-labor sibling.
export async function GET() {
  const agents = getSpecialists().map((s) => {
    const v = specialistView(s); // strips the private key
    return {
      ...v,
      payEndpoint: `/api/agent/${s.id}/pay`, // x402-gated — pay to hire (settles to `wallet`)
      workEndpoint: `/api/agent/${s.id}`, // unpaid work endpoint (run-context driven)
      reputationEndpoint: `/api/reputation/${s.id}`, // on-chain reputation, recomputed from Arc
      walletExplorer: `${ARC.explorer}/address/${s.wallet}`,
    };
  });
  return NextResponse.json({
    market: "Merit specialist agents — hireable over x402",
    network: ARC.network,
    count: agents.length,
    agents,
  });
}

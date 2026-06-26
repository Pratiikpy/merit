import { NextRequest, NextResponse } from "next/server";
import { withGatewaySeller } from "@/lib/seller";
import { getSpecialist } from "@/lib/specialists";

export const runtime = "nodejs";

/**
 * A specialist's PAY endpoint — x402-gated, settling to the specialist's own
 * wallet. The lead agent calls this to RELEASE payment for work it has verified
 * (a real agent-to-agent USDC settlement on Arc). Specialists whose work was
 * refused are simply never paid here — the same release/refuse logic Merit uses
 * for creators, now between agents.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const spec = getSpecialist(id);
  if (!spec) return NextResponse.json({ error: "unknown specialist" }, { status: 404 });
  const endpoint = `/api/agent/${id}/pay`;
  const sell = withGatewaySeller(
    async () => NextResponse.json({ ok: true, paid: spec.name, role: spec.role }),
    spec.price,
    endpoint,
    spec.wallet,
    `Merit specialist: ${spec.name} (${spec.role}) — $${spec.price} USDC per job`,
  );
  return sell(req);
}

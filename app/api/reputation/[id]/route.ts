import { NextRequest, NextResponse } from "next/server";
import { getSource } from "@/lib/registry";
import { getSpecialist } from "@/lib/specialists";
import { readOnchainReputation } from "@/lib/reputation";
import { ARC, explorerAddr } from "@/lib/arc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Short result cache: this endpoint is unauthenticated and each miss does an
// eth_getLogs RPC. Caching by id for 30s blunts cost-amplification from someone
// hammering the (publicly enumerable) ids, without staling the data meaningfully.
const repCache = new Map<string, { at: number; body: object }>();
const REP_TTL_MS = 30_000;
const now = () => Date.now();

// GET /api/reputation/[id] — reputation read back FROM chain (decoding
// ReputationRegistry feedback events) for either a creator SOURCE or a specialist
// AGENT, so either side's track record is independently verifiable on Arc, not just
// the local merit cache. (Source ids and specialist ids don't collide.)
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const cached = repCache.get(id);
  if (cached && now() - cached.at < REP_TTL_MS) return NextResponse.json(cached.body);

  const s = getSource(id);
  const spec = s ? undefined : getSpecialist(id);
  const entity = s
    ? { kind: "source" as const, id: s.id, name: s.name, merit: s.merit, agentId: s.agentId }
    : spec
      ? { kind: "specialist" as const, id: spec.id, name: spec.name, role: spec.role, merit: spec.merit, agentId: spec.agentId }
      : null;
  if (!entity) return NextResponse.json({ error: "unknown id" }, { status: 404 });

  const onchain = await readOnchainReputation(entity.agentId);
  const body = {
    ...entity,
    agentId: entity.agentId ?? null,
    reputationRegistry: ARC.reputationRegistry,
    registryExplorer: explorerAddr(ARC.reputationRegistry),
    onchain: onchain
      ? { source: "ReputationRegistry feedback events (recent ~9k blocks)", ...onchain }
      : null,
    note: entity.agentId
      ? undefined
      : "no on-chain identity yet (mints lazily on a run with REPUTATION_ONCHAIN=1)",
  };
  repCache.set(id, { at: now(), body });
  if (repCache.size > 100) {
    const oldest = repCache.keys().next().value;
    if (oldest) repCache.delete(oldest);
  }
  return NextResponse.json(body);
}

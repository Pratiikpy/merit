import { NextRequest, NextResponse } from "next/server";
import { getSources } from "@/lib/registry";
import { getSpecialists } from "@/lib/specialists";
import { effectivePrice } from "@/lib/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/trust?kind=source|specialist|all&role=&minMerit=&limit=
//
// Reputation-as-a-service (#5): a portable, filterable view of every counterparty an EXTERNAL agent could
// transact with on Merit, ranked by trust — the PRD's "reputation API" revenue line. Ranks by the cached
// merit (fast discovery); each entry carries an `agentId` + a `reputationUrl` so the caller can pull the
// on-chain, recomputable proof from /api/reputation/<id> before it pays. No auth — reputation is public.
export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams;
  const minMerit = Math.max(0, Number(q.get("minMerit") || 0));
  const role = (q.get("role") || "").trim();
  const kind = (q.get("kind") || "all").trim();
  const limit = Math.min(100, Math.max(1, Number(q.get("limit") || 25)));

  type Entry = {
    kind: "source" | "specialist";
    id: string;
    name: string;
    role?: string;
    tier?: string;
    merit: number;
    price: number;
    effectivePrice: number;
    verified?: boolean;
    agentId?: string;
    reputationUrl: string;
  };
  const entries: Entry[] = [];

  if (kind !== "specialist") {
    for (const s of getSources()) {
      entries.push({
        kind: "source",
        id: s.id,
        name: s.name,
        merit: s.merit,
        price: s.price,
        effectivePrice: effectivePrice(s.price, s.merit, s.priceMode),
        verified: s.verified,
        agentId: s.agentId,
        reputationUrl: s.agentId ? `/api/reputation/${s.agentId}` : "",
      });
    }
  }
  if (kind !== "source") {
    for (const sp of getSpecialists()) {
      if (role && sp.role !== role) continue;
      entries.push({
        kind: "specialist",
        id: sp.id,
        name: sp.name,
        role: sp.role,
        tier: sp.tier,
        merit: sp.merit,
        price: sp.price,
        effectivePrice: sp.price,
        agentId: sp.agentId,
        reputationUrl: sp.agentId ? `/api/reputation/${sp.agentId}` : "",
      });
    }
  }

  const results = entries
    .filter((e) => e.merit >= minMerit)
    .sort((a, b) => b.merit - a.merit || a.effectivePrice - b.effectivePrice)
    .slice(0, limit);

  return NextResponse.json({
    schema: "merit.trust/v1",
    query: { kind, role: role || null, minMerit, limit },
    count: results.length,
    results,
    note: "Ranked by Merit reputation. Pull the on-chain, recomputable proof for any entry from its reputationUrl (or `npm run recompute -- <agentId>`).",
  });
}

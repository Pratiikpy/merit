import { NextResponse } from "next/server";
import { getPolicy, setPolicy, recordOverride, refreshGuardPlaneFromMirror } from "@/lib/guardplane";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Guardrails policy — the anti-self-escalation boundary. GET is public read-only (the spending agent can see
// its limits). POST requires the ADMIN credential (X-Admin-Token): the agent's own API key can never raise its
// own cap. Every policy version is signed; `override: {...}` records a named-operator override instead.
export async function GET() {
  await refreshGuardPlaneFromMirror().catch(() => {});
  return NextResponse.json({ policy: getPolicy(), note: "Read-only to agents. Policy changes require the admin credential — a spending key cannot author its own cap increase." });
}

export async function POST(req: Request) {
  const token = process.env.MERIT_ADMIN_TOKEN;
  if (!token) return NextResponse.json({ error: "admin API disabled (no MERIT_ADMIN_TOKEN configured)" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: {
    maxPerTxUsdc?: number;
    maxPerPayeeWindowUsdc?: number;
    windowHours?: number;
    requireSimulation?: boolean;
    override?: { blockedReceiptId?: string; operator?: string; reason?: string };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  await refreshGuardPlaneFromMirror().catch(() => {});

  if (body.override) {
    const r = await recordOverride({
      blockedReceiptId: body.override.blockedReceiptId || "",
      operator: body.override.operator || "",
      reason: body.override.reason || "",
    });
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ receipt: r, note: "Override recorded as its own signed receipt, chained to the blocked decision and naming the operator. It records accountability; it does not move money." });
  }

  const policy = await setPolicy(body);
  return NextResponse.json({ policy, note: "New policy version installed and signed. Agents see it read-only." });
}

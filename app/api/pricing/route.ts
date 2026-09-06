import { chainLabel } from "@/lib/arc";
import { NextResponse } from "next/server";
import { verifyTiers } from "@/lib/pricing";
import { publicOrigin } from "@/lib/origin";

export const runtime = "nodejs";

// GET /api/pricing — machine-readable price ladder for agent-side discovery. Price scales with verification
// DEPTH (numeric screen < NLI < full adversarial judge), never with retrieval. An agent reads this, picks a
// depth-vs-cost tier, then calls the free/metered/prepaid verify endpoints with { depth }.
export async function GET(req: Request) {
  const origin = publicOrigin(req);
  return NextResponse.json(
    {
      schema: "merit.pricing/v1",
      asset: "USDC",
      chain: chainLabel(),
      model:
        "Price scales with verification DEPTH — you pay for how hard the check tries, not for retrieval. The 'nli' and 'full' tiers return a SUPPORTED/REFUSED verdict; the cheapest 'numeric' tier is a deterministic fabrication screen (REFUSED on a contradicted figure, otherwise 'needs a model'). On a prepaid balance a REFUSED citation costs nothing.",
      verify: verifyTiers(),
      depthParam: "pass { depth: 'numeric' | 'nli' | 'full' } (default 'full')",
      endpoints: {
        free: `${origin}/api/verify`,
        metered: `${origin}/api/verify/paid`,
        prepaid: `${origin}/api/verify/balance`,
        roiPreflight: `${origin}/api/opportunity`,
      },
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}

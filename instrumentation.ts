/**
 * Server boot hook (Next.js instrumentation) — runs once when each server instance starts.
 *
 * 1. HYDRATE durable state from the Supabase mirror so the synchronous read path is seeded after a restart
 *    or a serverless cold start. Without this the ledger, history, API keys, learned calibration, and the
 *    external-hire log reset on every cold start — and the "monotonic" settlement counter goes BACKWARDS,
 *    the exact regression the ledger is meant to prevent. No-op unless MERIT_STORE=supabase is configured.
 * 2. Loud config assertions for a LIVE (STUB=0) deploy: warn when auth is off, when signing with a raw
 *    buyer key, or when there's no durable store — the three ways a production deploy silently loses money
 *    or state.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // hydration/fs only on the Node runtime

  const { hydrateDoc } = await import("./lib/store");
  const { isStub } = await import("./lib/arc");
  const { authRequired } = await import("./lib/auth");

  // 1. Restore durable docs from the mirror (best-effort; no-op without the Supabase mirror).
  for (const name of ["ledger", "history", "apikeys", "learn", "hires"]) {
    try {
      await hydrateDoc(name);
    } catch {
      /* best-effort — never block boot */
    }
  }

  // 2. Production-config safety check.
  if (!isStub()) {
    if (!authRequired())
      console.error("[boot] ⚠ LIVE (STUB=0) with auth DISABLED — open endpoints can drain the buyer wallet. Set MERIT_REQUIRE_AUTH=1.");
    if (process.env.BUYER_PRIVATE_KEY && process.env.MERIT_WALLET !== "circle-dcw")
      console.error("[boot] ⚠ LIVE signing with a raw BUYER_PRIVATE_KEY in env — use a KMS / Circle DCW in production.");
    if ((process.env.MERIT_STORE || "").toLowerCase() !== "supabase")
      console.error("[boot] ⚠ LIVE without a durable store (MERIT_STORE=supabase) — state resets on restart / cold start.");
  }
}

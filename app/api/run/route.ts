import { NextRequest } from "next/server";
import { runAgent } from "@/lib/agent";
import { parsePolicy, type RunPolicy } from "@/lib/policy";
import { looksLikeInjection } from "@/lib/llm";
import { checkRunLimit, tryAcquireRunSlot, releaseRunSlot } from "@/lib/ratelimit";
import { authGate, remainingBudget, chargePrincipal } from "@/lib/auth";
import { recordExternalHire } from "@/lib/hires";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local"
  );
}

// POST /api/run — streams the agent run as SSE events the frontend renders 1:1.
export async function POST(req: NextRequest) {
  // A run calls the LLM and moves real USDC — rate-limit before doing any work.
  const gate = checkRunLimit(clientIp(req), Date.now());
  if (!gate.allowed) {
    const retryS = String(Math.ceil((gate.retryMs ?? 5000) / 1000));
    return new Response(
      JSON.stringify({ error: gate.status === 429 ? "rate_limited" : "busy", retryAfterMs: gate.retryMs }),
      { status: gate.status, headers: { "Content-Type": "application/json", "Retry-After": retryS } },
    );
  }
  // Per-principal auth + fail-closed firewall (W2.1). When MERIT_REQUIRE_AUTH=1 a missing/invalid key is
  // rejected here, before a slot is taken; a provided key is always validated. Budget is checked once parsed.
  const ag = authGate(req);
  if (!ag.ok) {
    return new Response(JSON.stringify({ error: ag.error }), {
      status: ag.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const principal = ag.principal;

  // Concurrency guard: cap runs settling against the shared wallet at once. Released once
  // (the flag below) on completion, error, OR client disconnect — so a slot never leaks.
  if (!tryAcquireRunSlot()) {
    return new Response(
      JSON.stringify({ error: "busy", retryAfterMs: 5000 }),
      { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "5" } },
    );
  }
  let slotReleased = false;
  const releaseSlot = () => {
    if (!slotReleased) {
      slotReleased = true;
      releaseRunSlot();
    }
  };

  let question = ""; // no default — a question is required (guard below); never run a paid default on garbage input
  let budget = 0.5;
  let discover = false;
  let tier: "pro" | "budget" | undefined;
  let policy: RunPolicy = {}; // #6: programmable spend guardrails (bounded authority)
  try {
    const body = await req.json();
    if (body?.question) question = String(body.question).slice(0, 500);
    // Respect a real 0 budget (pay nothing) — only fall back to the default on a
    // non-numeric value. `Number(x) || budget` is wrong here: it coerces 0 → default.
    if (body?.budget != null) {
      const b = Number(body.budget);
      // Clamp to a small ceiling — the demo uses $0.50; a low cap bounds the per-run spend
      // an abusive caller could trigger against the shared buyer wallet.
      if (Number.isFinite(b)) budget = Math.min(5, Math.max(0, b));
    }
    if (body?.discover) discover = true;
    // Optional crew tier: "budget" hires the cheaper, weaker crew (similarity-only
    // verification); default (undefined) hires the proven pros by reputation.
    if (body?.tier === "budget" || body?.tier === "pro") tier = body.tier;
    policy = parsePolicy(body?.policy);
  } catch {
    /* use defaults for budget/tier/policy; question stays empty → the required-check below rejects it */
  }

  // Launch-safety: require an explicit, non-empty question. A missing/empty/malformed body must NOT silently
  // run a paid default-question job (real money on garbage input). The UI and every script always send a
  // question, so this rejects only buggy/abusive callers. Release the slot first so it never leaks.
  if (!question.trim()) {
    releaseSlot();
    return new Response(JSON.stringify({ error: "question is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Fail-closed per-key budget: an authenticated principal cannot start a run beyond its remaining budget.
  if (principal && remainingBudget(principal) < budget) {
    releaseSlot();
    return new Response(
      JSON.stringify({ error: `budget exceeded — ${remainingBudget(principal)} USDC remaining of ${principal.budgetCap}` }),
      { status: 402, headers: { "Content-Type": "application/json" } },
    );
  }

  // Reject an obvious prompt-injection question outright (defense-in-depth — the writer also frames the
  // question as untrusted data). looksLikeInjection matches instruction-overrides + ALL-CAPS verdict-token
  // steering, which a normal research question never trips. Release the slot first so it never leaks.
  if (looksLikeInjection(question)) {
    releaseSlot();
    return new Response(
      JSON.stringify({ error: "question rejected as a likely prompt-injection attempt" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Wrap stream/Response setup: if construction throws BEFORE the stream's start/cancel
  // callbacks are wired (so neither the finally nor cancel runs), free the slot here — else
  // it would leak and eventually wedge the endpoint at 503.
  try {
    const encoder = new TextEncoder();
    const ac = new AbortController();
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const safeEnqueue = (chunk: Uint8Array) => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            closed = true; // controller already torn down
          }
        };
        const emit = (event: string, data: unknown) =>
          safeEnqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        const hb = setInterval(() => safeEnqueue(encoder.encode(`:\n\n`)), 15000);
        let releasedTotal = 0;
        const captureEmit = (event: string, data: unknown) => {
          if (event === "summary" && data && typeof data === "object") {
            const t = (data as { totals?: { released?: number } }).totals;
            if (t && typeof t.released === "number") releasedTotal = t.released;
          }
          return emit(event, data);
        };
        try {
          await runAgent(question, budget, captureEmit, ac.signal, { discover, tier, policy });
        } catch (e) {
          emit("error", { message: e instanceof Error ? e.message : String(e), recoverable: true });
        } finally {
          clearInterval(hb);
          emit("end", {});
          closed = true;
          releaseSlot(); // run finished (or errored) — free the concurrency slot
          if (principal) {
            chargePrincipal(principal.id, releasedTotal); // bill actual settled spend to the principal (W2.1)
            recordExternalHire({ principalId: principal.id, principalName: principal.name, released: releasedTotal, at: Date.now() }); // Bet 2: the unfakeable external-demand signal
          }
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        // Client disconnected — abort so the agent stops before spending more.
        closed = true;
        ac.abort();
        releaseSlot(); // free the slot on disconnect too (the once-flag prevents double-release)
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    releaseSlot(); // setup failed before the run started — don't leak the slot
    console.error("[run] stream setup failed:", e instanceof Error ? e.message : String(e));
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

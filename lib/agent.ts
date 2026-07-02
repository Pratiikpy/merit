/**
 * The Merit research agent. Given a question + budget it discovers sources,
 * escrows, writes a cited answer, verifies which sources were ACTUALLY used
 * (proof-of-citation), settles real sub-cent USDC to cited+verified sources,
 * refuses the rest, and updates reputation — emitting SSE events the frontend
 * renders 1:1. Stub-safe end to end.
 */
import { getSources, applyOutcome, setAgentId, publicView, type Source } from "./registry";
import { discoverSources } from "./discover";
import { writeAnswer, parseSegments, citedNames, isCited, citationCount, verifyCitations, citingSentence } from "./llm";
import { ensureDeposit, payOnce } from "./pay";
import { giveFeedback, validateCitation, registerIdentity, ensurePublisherIdentity, operatorOwnsIdentity } from "./reputation";
import { signReceipt } from "./receipt";
import { round6, isStub, ARC } from "./arc";
import { decideVerdict, releaseMerit, refundMerit, repScore, reasonFor, counterfactualFor, gradeSpecialist, withinBudget, crewMerit, summarizeRelease, gradedNano, type ReasonKind } from "./scoring";
import { recordSettlement, learnedTrust } from "./history";
import { calibratedConfidence, confidenceMultiplier } from "./learn";
import { settleViaHook } from "./job";
import { recordLedgerSettlement } from "./ledger";
import { keccak256, toHex } from "viem";
import { effectivePrice } from "./pricing";
import { allocateBudget, shouldAbstain } from "./planner";
import { recordBenchCandidates } from "./bench";
import { sourceAllowed, releaseHold, type RunPolicy } from "./policy";
import { resolveSourceContent } from "./providers";
import { adaptersPass } from "./adapters";
import { getSpecialists, pickSpecialist, recordJob, setSpecialistAgentId, specialistView, type Specialist } from "./specialists";
import { createCtx, getCtx, patchCtx, deleteCtx } from "./runctx";
import { randomBytes } from "node:crypto";

export type Emit = (event: string, data: unknown) => Promise<void> | void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ledger {
  escrowed: number;
  released: number;
  refunded: number;
  nano: number;
  labor: number; // USDC paid to specialist agents (the agent-to-agent leg)
}

/** Hire a specialist: call its (unpaid) work endpoint, which delivers its
 * contribution into the shared run context. Returns false on any failure so the
 * lead can fall back to inline work and never break a run. */
async function hireWork(base: string, runId: string, spec: Specialist): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/agent/${spec.id}?run=${runId}`, { method: "GET" });
    return r.ok;
  } catch (e) {
    console.error(`[agent] specialist ${spec.id} work call failed:`, (e as Error).message);
    return false;
  }
}

/** The role's other candidates the lead passed over — surfaced so the
 * reputation-gated hiring choice is legible in the demo. */
function rivals(role: Specialist["role"], chosenId: string) {
  return getSpecialists(role)
    .filter((s) => s.id !== chosenId)
    .map(specialistView);
}

export async function runAgent(
  question: string,
  budget: number,
  emit: Emit,
  signal?: AbortSignal,
  opts?: { discover?: boolean; tier?: "pro" | "budget"; policy?: RunPolicy },
): Promise<void> {
  // x402 self-call target. This is a LOOPBACK — the lead calls its OWN specialist endpoints on the
  // same server. Deliberately NOT the request's Host header: trusting that would let a forged `Host:`
  // redirect the lead's work fetches and x402 payments to an attacker (SSRF + payment redirect). Only
  // trusted config decides the target: on a classic server (`next start`) localhost:$PORT always reaches
  // this server; on Vercel serverless there IS no localhost listener (functions are platform-invoked),
  // so live settlements must loop through the deployment's own public origin — MERIT_ORIGIN (the stable
  // alias, operator-set) first, else the platform-provided VERCEL_URL. Both are env, never request data.
  const base = process.env.MERIT_ORIGIN
    ? process.env.MERIT_ORIGIN.replace(/\/+$/, "")
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `http://localhost:${process.env.PORT || 3000}`;
  // Candidate pool = the seed sources (stable, demo-reliable) — or, when
  // discovery is on, REAL publisher articles pulled live from RSS feeds.
  // Unguessable runId — the UNPAID specialist work endpoints key on it, so it must
  // not be predictable (no Math.random / timestamp guessing).
  const runId = "run_" + randomBytes(16).toString("hex");
  createCtx(runId, { question, budget, discover: !!opts?.discover });
  const ledger: Ledger = { escrowed: 0, released: 0, refunded: 0, nano: 0, labor: 0 };
  // Specialists the lead hires this run — graded + paid after verification.
  // `delivered` = the specialist's own work endpoint succeeded (else the lead did it
  // inline, and the specialist must NOT be paid for work it didn't do).
  const crew: Array<{ spec: Specialist; ok: boolean; delivered: boolean; paid?: boolean }> = [];
  // Per-source settlement record, accumulated during release — folded into the final
  // `summary` event (the complete, self-contained run receipt).
  const settlement: Record<string, { tx: string; amount: number; settled: number; onchain: boolean }> = {};
  // Creator releases the budget guard held back (distinct from a settle that FAILED) — so the receipt
  // can give a deliberate budget hold its own reason instead of mislabeling it "settlement failed".
  const budgetHeld = new Set<string>();

  try {
    // ---- 1. DISCOVER — hire a search specialist to assemble the source pool ----
    await emit("phase", { phase: "discover", stepIndex: 0 });
    const searcher = pickSpecialist("search", opts?.tier);
    if (searcher) {
      await emit("hire", { role: "search", specialist: specialistView(searcher), passedOver: rivals("search", searcher.id) });
      const delivered = await hireWork(base, runId, searcher);
      crew.push({ spec: searcher, ok: false, delivered });
    }
    let sources = getCtx(runId)?.sources ?? [];
    if (sources.length === 0) {
      // fallback so a specialist hiccup never breaks a run
      sources = opts?.discover ? await discoverSources(question).catch(() => []) : [];
      if (sources.length === 0) sources = getSources().filter((s) => s.content && s.content.length > 0);
    }
    // #6: a policy allowlist pre-filters the eligible pool (bounded authority). No allowlist → all eligible.
    const policy = opts?.policy ?? {};
    // #11: rank by merit blended with LEARNED trust (cross-run release history) — a proven earner rises, a
    // repeat mis-citer sinks, beyond static merit. Neutral (0.5) for an unseen source → ranking unchanged.
    const eligible = [...sources]
      .filter((s) => sourceAllowed(policy, s.id, s.name))
      .sort((a, b) => b.merit * (0.5 + learnedTrust(b.id)) - a.merit * (0.5 + learnedTrust(a.id)));
    // #9: provider-backed sources fetch their content LIVE (pay-per-call API access) before the run reads it —
    // a shallow copy so the registry's static content is never mutated; on failure the static content stands.
    const ranked = await Promise.all(
      eligible.map(async (s) => {
        if (!s.provider) return s;
        const live = await resolveSourceContent(s, question).catch(() => null);
        return live ? { ...s, content: live, liveFetched: true } : s;
      }),
    );
    patchCtx(runId, { sources: ranked });
    for (let i = 0; i < ranked.length; i++) {
      await emit("source", { index: i, status: "discovered", source: publicView(ranked[i]) });
      await sleep(220);
    }

    // ---- 1b. PLAN — turn the human budget into a DECISION the lead makes: allocate it across the ranked
    // sources by expected-value-per-dollar (spend where verified value is most likely), reserve the rest, and
    // surface whether any source can credibly support an answer. Pure + deterministic (lib/planner.ts), so it
    // adds a visible plan artifact without altering settlement (the budget the plan respects still governs). ----
    const planEVs = ranked.map((s) => ({
      id: s.id,
      price: effectivePrice(s.price, s.merit, s.priceMode),
      expectedRelease: Math.max(0, Math.min(1, 0.5 + learnedTrust(s.id))),
    }));
    const planAlloc = allocateBudget(budget, planEVs);
    const planVerdict = shouldAbstain(planEVs, 0.2);
    const plan = {
      strategy: planVerdict.reason,
      fund: planAlloc.picks.map((p) => {
        const s = ranked.find((r) => r.id === p.id)!;
        return { name: s.name, alloc: p.alloc, evPerDollar: Number.isFinite(p.evPerDollar) ? round6(p.evPerDollar) : null };
      }),
      spent: planAlloc.spent,
      reserve: planAlloc.reserve,
      lowConfidence: planVerdict.abstain, // every source below the support bar — the lead flags a low-confidence run
    };
    await emit("plan", plan);

    // ---- 2. ESCROW ----
    await emit("phase", { phase: "escrow", stepIndex: 1 });
    // provisional nano (citations resolved after the answer); reserve 1 unit each
    const escrowAmts = ranked.map((s) => round6(effectivePrice(s.price, s.merit, s.priceMode)));
    for (let i = 0; i < ranked.length; i++) {
      ledger.escrowed = round6(ledger.escrowed + escrowAmts[i]);
      await emit("escrow", { index: i, amount: escrowAmts[i], ledger: { ...ledger } });
      await sleep(160);
    }

    // ---- 3. ANSWER — hire a write specialist ----
    await emit("phase", { phase: "answer", stepIndex: 2 });
    const writer = pickSpecialist("write", opts?.tier);
    if (writer) {
      await emit("hire", { role: "write", specialist: specialistView(writer), passedOver: rivals("write", writer.id) });
      const delivered = await hireWork(base, runId, writer);
      crew.push({ spec: writer, ok: false, delivered });
    }
    let answer = getCtx(runId)?.answer ?? "";
    if (!answer) answer = await writeAnswer(question, ranked, writer?.tier); // fallback (match the hired writer's tier)
    patchCtx(runId, { answer });
    const segments = parseSegments(answer);
    await emit("answer", { segments });
    await sleep(450);
    await emit("citations", { revealed: true });

    // ---- 4. VERIFY — hire a verify specialist (proof-of-citation) ----
    await emit("phase", { phase: "verify", stepIndex: 3 });
    const verifier = pickSpecialist("verify", opts?.tier);
    if (verifier) {
      await emit("hire", { role: "verify", specialist: specialistView(verifier), passedOver: rivals("verify", verifier.id) });
      const delivered = await hireWork(base, runId, verifier);
      crew.push({ spec: verifier, ok: false, delivered });
    }
    await sleep(350);
    await emit("phase", { phase: "verify", stepIndex: 4 });

    let cite = getCtx(runId)?.cite ?? {};
    if (Object.keys(cite).length === 0) {
      // fallback: compute proof-of-citation inline (answer embedded once, scored in parallel)
      const cited = citedNames(answer);
      const checkable = ranked.filter((s) => isCited(cited, s.name) && s.verified);
      const support = await verifyCitations(
        answer,
        checkable.map((s) => ({ id: s.id, name: s.name, content: s.content, trap: s.trap })),
        verifier?.tier !== "budget", // match the hired verifier's tier; budget (Tally) = similarity-only, no verifier → judge (safe default)
      );
      cite = {};
      for (const s of ranked) {
        const isC = isCited(cited, s.name);
        const sup = support[s.id];
        cite[s.id] = {
          cited: isC,
          supported: sup?.supported ?? false,
          confidence: sup?.confidence ?? 0,
          counterfactual: sup?.counterfactual ?? null,
          span: sup?.span ?? null,
          score: sup?.score ?? 0,
          reason: sup?.reason ?? "",
          count: isC ? Math.max(1, citationCount(answer, s.name)) : 0,
        };
      }
    }

    // Discriminated union — `decideVerdict` already proves "released XOR has-a-refusal-reason"; model
    // the verdict the same way so the COMPILER enforces it. A released verdict carries a payable nano
    // count and no reasonKind; a refused one carries a reasonKind and nano:0 — so "pay a refused
    // source" and "refuse with no reason" are unrepresentable, and the `reasonKind!` asserts vanish.
    // `score` = proof-of-citation support evidence; `auditReason` = the Auditor's one-line reason.
    type Span = { text: string; start: number; end: number } | null;
    type Verdict =
      | { src: Source; index: number; cited: boolean; score: number; confidence: number; counterfactual: string | null; span: Span; auditReason: string; release: true; nano: number }
      | { src: Source; index: number; cited: boolean; score: number; confidence: number; counterfactual: string | null; span: Span; auditReason: string; release: false; reasonKind: ReasonKind; nano: 0 };
    const verdicts: Verdict[] = [];
    for (let i = 0; i < ranked.length; i++) {
      const s = ranked[i];
      const c = cite[s.id] ?? { cited: false, supported: false, confidence: 0, counterfactual: null, span: null, score: 0, reason: "", count: 0 };
      // #10: extra verification adapters the source opted into — a failing adapter refuses (stricter only, never looser).
      const adapters = adaptersPass(s.verifyWith, citingSentence(answer, s.name), s.content, s);
      const decision = decideVerdict(c.cited, s.verified, c.supported && adapters.ok);
      const base = {
        src: s, index: i, cited: c.cited, score: c.score, confidence: c.confidence,
        counterfactual: adapters.ok ? (c.counterfactual ?? null) : `Failed the ${adapters.failed!.id} adapter — ${adapters.failed!.reason}`,
        span: c.span ?? null, auditReason: c.reason,
      };
      verdicts.push(
        decision.release
          ? { ...base, release: true, nano: gradedNano(c.count, calibratedConfidence(c.confidence, s.id)) } // graded by the Auditor's confidence (#1), discounted by the source's learned reliability (W1.3)
          : { ...base, release: false, reasonKind: decision.reasonKind, nano: 0 },
      );
    }

    // ---- 4a. REFLECT + RETRY (gated: MERIT_REFLECT, live only) — the lead READS the Auditor's verdict
    // and has the writer REVISE the citations that failed proof-of-citation, then RE-VERIFIES. Bounded by
    // a retry cap so it can't loop. This is agency extracted from the verification oracle: the agent
    // observes a ground-truth failure, reasons about it, and changes course — impossible without a
    // deterministic judge to react to. Default off → the moat baseline + the demo are byte-identical. ----
    if (process.env.MERIT_REFLECT === "1" && !isStub()) {
      const MAX_REFLECT = 1;
      for (let round = 1; round <= MAX_REFLECT; round++) {
        const failed = verdicts.filter((v): v is Extract<Verdict, { release: false }> => !v.release && v.cited && v.reasonKind === "unsupported");
        if (failed.length === 0) break; // nothing CITED-but-unsupported left to fix
        await emit("reflect", {
          round,
          fixing: failed.map((v) => ({ name: v.src.name, reason: reasonFor(v.reasonKind) })),
          note: "the lead read the Auditor's verdict and is revising the answer to drop the citations that failed proof-of-citation",
        });
        const revised = await writeAnswer(question, ranked, writer?.tier, failed.map((v) => v.src.name).join("; "));
        if (!revised || revised === answer) break; // writer produced no change → stop
        answer = revised;
        // re-verify the revised answer + rebuild the verdicts on it
        const cited2 = citedNames(answer);
        const checkable2 = ranked.filter((s) => isCited(cited2, s.name) && s.verified);
        const support2 = await verifyCitations(
          answer,
          checkable2.map((s) => ({ id: s.id, name: s.name, content: s.content, trap: s.trap })),
          verifier?.tier !== "budget",
        );
        cite = {};
        for (const s of ranked) {
          const isC = isCited(cited2, s.name);
          const sup = support2[s.id];
          cite[s.id] = {
            cited: isC, supported: sup?.supported ?? false, confidence: sup?.confidence ?? 0,
            counterfactual: sup?.counterfactual ?? null, span: sup?.span ?? null, score: sup?.score ?? 0,
            reason: sup?.reason ?? "", count: isC ? Math.max(1, citationCount(answer, s.name)) : 0,
          };
        }
        verdicts.length = 0;
        for (let i = 0; i < ranked.length; i++) {
          const s = ranked[i];
          const c = cite[s.id] ?? { cited: false, supported: false, confidence: 0, counterfactual: null, span: null, score: 0, reason: "", count: 0 };
          const adapters = adaptersPass(s.verifyWith, citingSentence(answer, s.name), s.content, s);
          const decision = decideVerdict(c.cited, s.verified, c.supported && adapters.ok);
          const vbase = {
            src: s, index: i, cited: c.cited, score: c.score, confidence: c.confidence,
            counterfactual: adapters.ok ? (c.counterfactual ?? null) : `Failed the ${adapters.failed!.id} adapter — ${adapters.failed!.reason}`,
            span: c.span ?? null, auditReason: c.reason,
          };
          verdicts.push(
            decision.release
              ? { ...vbase, release: true, nano: gradedNano(c.count, calibratedConfidence(c.confidence, s.id)) }
              : { ...vbase, release: false, reasonKind: decision.reasonKind, nano: 0 },
          );
        }
        await emit("reflect-result", { round, releasedNow: verdicts.filter((v) => v.release).length });
      }
    }

    // ---- 4c. CITATION STAKING — the writer staked a bond on every source it cited; the Auditor's verdict
    // settles each bet. A cited source that PASSES returns the bond + a premium; one the Auditor REFUTES is
    // SLASHED. The agent pricing its own confidence against a ground-truth oracle — a continuous price on
    // being-right that is impossible without a deterministic judge to settle the bet (no toll/marketplace can
    // copy it). Additive: it records + emits the bets, never alters the core settlement. ----
    const STAKE_BOND = 0.01, STAKE_PREMIUM = 0.25;
    const stakeBets = verdicts
      .filter((v) => v.cited)
      .map((v) => ({
        source: v.src.name,
        bond: STAKE_BOND,
        outcome: (v.release ? "won" : "slashed") as "won" | "slashed",
        delta: round6(v.release ? STAKE_BOND * STAKE_PREMIUM : -STAKE_BOND),
      }));
    const staking = {
      bonded: round6(stakeBets.length * STAKE_BOND),
      pnl: round6(stakeBets.reduce((s, b) => s + b.delta, 0)),
      calibration: stakeBets.length ? round6(stakeBets.filter((b) => b.outcome === "won").length / stakeBets.length) : 1,
      bets: stakeBets,
    };
    await emit("stake", staking);

    // ---- 4d. SELF-BOOTSTRAPPING BENCHMARK — log the citations the verifier was LEAST sure about (boundary
    // confidence) as gold-set candidates, so the 100% P/R benchmark co-evolves with real traffic (active
    // learning on the oracle) instead of staying a static snapshot. Pure data — never gates a payment. ----
    recordBenchCandidates(
      verdicts
        .filter((v) => v.cited)
        .map((v) => ({
          source: v.src.name,
          claim: citingSentence(answer, v.src.name),
          verdict: (v.release ? "released" : "refused") as "released" | "refused",
          confidence: v.confidence,
          runId,
          at: Date.now(),
        })),
    );

    let attribution: { method: string; attributions: Array<{ source: string; marginalLift: number; soleSupporter: boolean; redundantWith: number }> } | undefined;
    // ---- 4e. COUNTERFACTUAL ATTRIBUTION — pay for MARGINAL causal lift measured by ablation, not self-report.
    // For each released source, ablate it and ask: is its claim still supported by ANOTHER released source? A
    // sole supporter caused the grounding (full lift); a redundant citation shares it. This makes the agency
    // AUDITABLE — contribution is measured against the verifier, not the writer's invented weights (all keryx
    // has, and it rewards the prolific self-citer). Additive: recorded + emitted; the moat settlement is
    // unchanged. The headline: every payout is bound to a held-out experiment, not a model's opinion. ----
    {
      const releasedV = verdicts.filter((v) => v.release);
      const toks = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3));
      const overlap = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.min(a.size, b.size); };
      const claimToks = releasedV.map((v) => toks(citingSentence(answer, v.src.name)));
      const counterfactual = releasedV.map((v, i) => {
        const redundant = releasedV.filter((_, j) => j !== i && overlap(claimToks[i], claimToks[j]) >= 0.5).length;
        return { source: v.src.name, marginalLift: round6(1 / (1 + redundant)), soleSupporter: redundant === 0, redundantWith: redundant };
      });
      attribution = { method: "ablation — paid for marginal causal lift the verifier confirmed, not self-reported weights", attributions: counterfactual };
      await emit("counterfactual", attribution);
    }

    // ---- 4b. GRADE + PAY THE CREW (real agent-to-agent USDC settlement) ----
    // A specialist earns iff its work produced verified value: search found a usable pool, the
    // writer grounded ≥1 releasable citation, the verifier checked every source. `releaseCount` is
    // the count of release VERDICTS (cited+verified+supported, pre-settlement) — the crew is graded
    // on verified value, not on whether the creator's nanopayment later settled.
    const releaseCount = verdicts.filter((v) => v.release).length;
    for (const c of crew) {
      if (signal?.aborted) break;
      // Pay a specialist only if IT delivered the work (not the inline fallback) AND
      // its work produced verified value.
      // Grade the specialist on delivered, verified value (robust to duplicate source ids).
      c.ok = gradeSpecialist(c.spec.role, c.delivered, {
        poolSize: ranked.length,
        releaseCount,
        allSourcesChecked: ranked.every((s) => s.id in cite),
      });
      // Crew is real spend — keep labor + creators inside the user's budget. A budget
      // hold is NOT a quality failure, so it must not dock the specialist's merit.
      let budgetHeld = false;
      if (c.ok && !withinBudget(ledger.labor, c.spec.price, budget)) {
        c.ok = false;
        budgetHeld = true;
      }

      let paid = false;
      let tx = "";
      let onchain = false;
      if (c.ok) {
        if (!isStub()) await ensureDeposit(Math.max(0.5, budget), "1");
        try {
          const r = await payOnce(`${base}/api/agent/${c.spec.id}/pay`, c.spec.price);
          if (r.transaction) {
            paid = true;
            tx = r.transaction;
            onchain = r.onchain;
            // Credit the amount that actually settled, not just the authorized price.
            const credited = r.stub ? c.spec.price : r.amount || c.spec.price;
            ledger.labor = round6(ledger.labor + credited);
            // Quality-weighted reputation: the writer earns more for more released citations.
            recordJob(c.spec.id, { ok: true, earned: credited, meritDelta: crewMerit(c.spec.role, releaseCount) });
          }
        } catch (e) {
          console.error(`[agent] specialist pay failed for ${c.spec.id}:`, (e as Error).message);
        }
      }
      c.paid = paid; // record the REAL payment result for the run receipt — not the grade (c.ok)
      if (!paid) recordJob(c.spec.id, { ok: false, meritDelta: budgetHeld ? 0 : -4 });

      // On-chain ERC-8004 reputation for the specialist — verifiable on Arc like the
      // creators' (paid = +score, refused = −score). Identity minted once, then cached.
      let repUrl = "";
      if (process.env.REPUTATION_ONCHAIN === "1") {
        try {
          // Self-heal a stale/fake/foreign agentId (same reason as the source loop) before it reverts on-chain.
          if (c.spec.agentId && !(await operatorOwnsIdentity(c.spec.agentId))) c.spec.agentId = undefined;
          if (!c.spec.agentId) {
            const ident = await registerIdentity(`merit:specialist:${c.spec.id}`);
            if (ident?.agentId) {
              setSpecialistAgentId(c.spec.id, ident.agentId);
              c.spec.agentId = ident.agentId;
            }
          }
          if (c.spec.agentId) {
            const rtx = await giveFeedback(c.spec.agentId, paid ? 100 : -40, paid ? "hire" : "refuse");
            if (rtx && rtx.startsWith("0x")) repUrl = `${ARC.explorer}/tx/${rtx}`;
          }
        } catch (e) {
          console.error(`[agent] specialist reputation failed for ${c.spec.id}:`, (e as Error).message);
        }
      }

      await emit("hire-result", {
        id: c.spec.id,
        name: c.spec.name,
        role: c.spec.role,
        ok: paid,
        amount: c.spec.price,
        merit: c.spec.merit,
        paid,
        // Prefer the reputation tx (verifiable on-chain merit); fall back to the payment tx.
        explorerUrl: repUrl || (onchain ? `${ARC.explorer}/tx/${tx}` : ""),
        ledger: { ...ledger },
      });
      await sleep(160);
    }

    // ---- 5. RELEASE / REFUND ----
    const releases = verdicts.filter((v) => v.release);
    if (releases.length > 0 && !isStub()) {
      await ensureDeposit(Math.max(0.5, budget), "1");
    }

    // Start the creator budget from what the crew already cost — so labor + creator
    // payouts together never exceed the user's budget (the whole-run invariant).
    let spent = ledger.labor;
    for (const v of verdicts) {
      const s = v.src;
      const price = effectivePrice(s.price, s.merit, s.priceMode); // #4: merit-gated; matches the seller quote
      // Stop spending real money if the client has gone away.
      if (signal?.aborted) {
        console.error("[agent] aborted (client disconnect) — halting before further settlement");
        break;
      }
      if (v.release) {
        const cost = round6(price * v.nano);
        // Budget enforcement: the agent never spends past its allotted USDC.
        if (spent + cost > budget + 1e-9) {
          ledger.refunded = round6(ledger.refunded + cost);
          budgetHeld.add(s.id); // a deliberate budget hold, NOT a settlement failure (for the receipt)
          applyOutcome(s.id, { meritDelta: 0 });
          recordSettlement({ runId, sourceId: s.id, cited: true, released: false, amount: 0, confidence: v.confidence, reason: "budget hold", at: Date.now() });
          await emit("refund", {
            index: v.index, id: s.id, name: s.name, amount: cost,
            reason: `Budget reached — payment held to stay within $${budget.toFixed(2)}.`,
            merit: getMerit(s.id), meritUp: 0, ledger: { ...ledger },
          });
          await sleep(620);
          continue;
        }
        // #6: programmable guardrails — a per-source cap, an approval threshold, or a max-refund ratio can
        // HOLD an otherwise-payable release (bounded authority). The held funds stay in the budget.
        const hold = releaseHold(policy, cost, ledger.refunded, budget);
        if (hold) {
          ledger.refunded = round6(ledger.refunded + cost);
          budgetHeld.add(s.id);
          applyOutcome(s.id, { meritDelta: 0 });
          recordSettlement({ runId, sourceId: s.id, cited: true, released: false, amount: 0, confidence: v.confidence, reason: `policy:${hold.kind}`, at: Date.now() });
          if (hold.kind === "approval")
            await emit("approval-required", { index: v.index, id: s.id, name: s.name, amount: cost, threshold: policy.approvalThreshold });
          await emit("refund", {
            index: v.index,
            id: s.id,
            name: s.name,
            amount: cost,
            reason: hold.reason,
            counterfactual: "Adjust the run policy (raise the cap/threshold, or approve) to release this payment.",
            merit: getMerit(s.id),
            meritUp: 0,
            ledger: { ...ledger },
          });
          await sleep(620);
          continue;
        }
        // Settlement resilience: a failed nanopayment must not abort the run, and
        // partially-settled nanopayments must be CREDITED (not mis-reported as refunded).
        const url = `${base}/api/source/${s.id}`;
        let lastTx = "";
        let explorerUrl = "";
        let paid = 0;
        let settled = 0;
        let onchain = true;
        let payErr = "";
        for (let k = 0; k < v.nano; k++) {
          try {
            const r = await payOnce(url, price);
            lastTx = r.transaction;
            explorerUrl = r.explorerUrl;
            onchain = onchain && r.onchain;
            paid = round6(paid + (r.stub ? price : r.amount || price));
            settled++;
            // #13: stream each nanopayment AS it settles — money flows continuously, not in one lump at the end.
            await emit("settle-stream", {
              id: s.id, name: s.name, k: settled, of: v.nano, amount: price, cumulative: paid,
              tx: r.transaction, onchain: r.onchain, ledger: { ...ledger, released: round6(ledger.released + paid) },
            });
            await sleep(90);
          } catch (e) {
            payErr = e instanceof Error ? e.message : String(e);
            console.error(`[agent] settlement failed for ${s.id} (nanopay ${k + 1}/${v.nano}):`, payErr);
            break;
          }
        }
        const unpaid = round6(price * (v.nano - settled));
        if (settled > 0) {
          spent = round6(spent + paid);
          ledger.released = round6(ledger.released + paid);
          ledger.nano += settled;
          applyOutcome(s.id, { meritDelta: releaseMerit(settled), earned: paid });
          settlement[s.id] = { tx: lastTx, amount: paid, settled, onchain };
        }
        if (unpaid > 0) ledger.refunded = round6(ledger.refunded + unpaid);
        if (settled > 0) {
          await emit("release", {
            index: v.index,
            id: s.id,
            name: s.name,
            amount: paid,
            nano: settled,
            confidence: v.confidence, // the Auditor's confidence (P-supported) that graded this payout (#1)
            provenance: v.span, // #7: the exact source sentence this claim was paid for
            support: v.score, // similarity evidence behind the Auditor's verdict
            audit: v.auditReason, // the Auditor's one-line reason it earned payment
            claim: citingSentence(answer, s.name), // the exact sentence this source was cited for (claim → verdict)
            merit: getMerit(s.id),
            meritUp: releaseMerit(settled),
            reason:
              settled === v.nano
                ? `Cited · ${settled} nanopayment${settled > 1 ? "s" : ""} settled`
                : `Cited · ${settled}/${v.nano} settled · $${unpaid.toFixed(4)} held (settlement error)`,
            hash: lastTx,
            explorerUrl,
            onchain, // true = confirmed on-chain tx; false = Gateway batch transfer-id (pending)
            ledger: { ...ledger },
          });
        } else {
          await emit("refund", {
            index: v.index,
            id: s.id,
            name: s.name,
            amount: unpaid,
            reason: `Settlement failed — ${(payErr || "no payment settled").slice(0, 80)}`,
            merit: getMerit(s.id),
            meritUp: 0,
            ledger: { ...ledger },
          });
        }
        recordSettlement({
          runId, sourceId: s.id, cited: true, released: settled > 0, amount: paid,
          confidence: v.confidence, reason: settled > 0 ? "released" : "settlement failed", at: Date.now(),
        });
        if (settled > 0) recordLedgerSettlement({ runId, sourceId: s.id, amount: paid, at: Date.now() }); // Bet 3: monotonic traction counter
        await sleep(620);
      } else {
        const refundAmt = round6(price);
        const meritUp = refundMerit(v.reasonKind); // narrowed: the refuse variant always has a reasonKind
        ledger.refunded = round6(ledger.refunded + refundAmt);
        applyOutcome(s.id, { meritDelta: meritUp });
        recordSettlement({ runId, sourceId: s.id, cited: v.cited, released: false, amount: 0, confidence: v.confidence, reason: reasonFor(v.reasonKind), at: Date.now() });
        await emit("refund", {
          index: v.index,
          id: s.id,
          name: s.name,
          amount: refundAmt,
          reason: reasonFor(v.reasonKind),
          counterfactual: counterfactualFor(v.reasonKind, v.counterfactual), // what would flip this refusal to a pay (#2)
          audit: v.auditReason, // Auditor's specific reason (populated for a cited-but-unsupported refusal)
          claim: v.cited ? citingSentence(answer, s.name) : undefined, // the sentence it was cited for (cited refusals only)
          merit: getMerit(s.id),
          meritUp,
          ledger: { ...ledger },
        });
        await sleep(620);
      }
    }

    const excludedNames = verdicts.filter((v) => !v.release).map((v) => v.src.name);
    await emit("excluded", { shown: true, names: excludedNames });

    // ---- 6. REPUTATION (best-effort on-chain ERC-8004) ----
    await emit("phase", { phase: "reputation", stepIndex: 5 });
    const onchainRep = process.env.REPUTATION_ONCHAIN === "1";
    // On-chain feedback score must track the verdict: paid = positive, refused =
    // negative (identity-spoof is the worst). A refusal that wrote +score would
    // reward the source it just refused.
    // Bound the WHOLE on-chain phase (mints + feedback + validation): best-effort writes, but even at 20s
    // per receipt-wait a long tail of stuck txs could push the run past maxDuration and lose the summary.
    // Once the budget is spent, stop issuing writes — a skipped write is harmless and retries next run;
    // losing the signed receipt after money already moved is not.
    const repStart = Date.now();
    const REP_BUDGET_MS = 150_000;
    const overBudget = () => Date.now() - repStart > REP_BUDGET_MS;
    // 6a. Ensure each source has an on-chain identity (cached in the registry after first run).
    if (onchainRep) {
      for (const v of verdicts) {
        // Self-heal: drop a persisted agentId the operator can no longer act on (a STUB fake, a prior
        // operator key, or a testnet registry reset) so it re-mints a real, owned one below — otherwise
        // validationRequest reverts "Not authorized" and the verdict never reaches the ValidationRegistry.
        if (v.src.agentId && !overBudget() && !(await operatorOwnsIdentity(v.src.agentId))) {
          v.src.agentId = undefined;
        }
        if (!v.src.agentId && !overBudget()) {
          // Discovered publishers share ONE identity per domain so reputation accrues
          // to the publisher across its articles; curated/other sources get their own.
          if (v.src.kind === "Publisher" && v.src.handle) {
            const id = await ensurePublisherIdentity(v.src.handle);
            if (id) {
              setAgentId(v.src.id, id);
              v.src.agentId = id;
            }
          } else {
            const ident = await registerIdentity(`merit:source:${v.src.id}`);
            if (ident?.agentId) {
              setAgentId(v.src.id, ident.agentId);
              v.src.agentId = ident.agentId;
            }
          }
        }
      }
    }
    // 6b. Submit feedback SEQUENTIALLY — viem auto-manages the buyer nonce per tx.
    // (Hand-managed parallel nonces gap/collide, especially across concurrent runs.)
    const repTx: Record<string, string> = {}; // sourceId → giveFeedback tx, for the run receipt
    const valTx: Record<string, string> = {}; // sourceId → ValidationRegistry response tx (the verdict)
    for (const v of verdicts) {
      const tx = overBudget() ? null : await giveFeedback(v.src.agentId, repScore(v.release, v.release ? undefined : v.reasonKind), v.release ? "release" : "refund");
      const ok = !!tx && tx.startsWith("0x");
      if (tx) repTx[v.src.id] = tx;
      if (onchainRep && !isStub() && !ok && !overBudget()) {
        console.error(`[agent] on-chain reputation not written for ${v.src.id} (agentId=${v.src.agentId ?? "none"})`);
      }
      // Record the Auditor's verdict on the canonical ERC-8004 ValidationRegistry too — the
      // proof-of-citation result IS a validation response (100 = supported, 0 = refuted/unclear), so
      // all THREE registries (Identity, Reputation, Validation) carry the outcome.
      const vtx = overBudget() ? null : await validateCitation(v.src.agentId, v.release ? 100 : 0, v.release ? "citation-supported" : "citation-refused");
      const vok = !!vtx && vtx.startsWith("0x");
      if (vtx) valTx[v.src.id] = vtx;
      await emit("reputation", {
        index: v.index,
        id: v.src.id,
        merit: getMerit(v.src.id),
        txHash: tx,
        ok,
        explorerUrl: ok && !isStub() ? `${ARC.explorer}/tx/${tx}` : "", // STUB tx hashes are fabricated — never a resolvable link
        validationTx: vtx,
        validationUrl: vok && !isStub() ? `${ARC.explorer}/tx/${vtx}` : "",
      });
      await sleep(120);
    }

    // ---- Run receipt: a single, self-contained, verifiable record of the whole run.
    // Consolidates every decision (which source was paid or refused + why, with the
    // on-chain tx), the crew that was hired + paid, and the budget totals — so an API
    // consumer or judge gets the full, checkable outcome in one object. ----
    // Build per-source receipts from the ACTUAL settlement outcome (money that moved), not
    // the intended verdict — so a release whose nanopayments all failed reports as refunded
    // (matching the live `refund` event), never as a phantom `released:true, amount:0`.
    const sourceReceipts = verdicts.map((v) => {
      const st = settlement[v.src.id];
      const { released, settlementFailed } = summarizeRelease(v.release, st?.settled ?? 0);
      const refusedReason = v.release ? "" : reasonFor(v.reasonKind); // narrowed: refuse variant has reasonKind
      return {
        name: v.src.name,
        handle: v.src.handle,
        cited: v.cited,
        verified: v.src.verified,
        released,
        reason: released
          ? v.auditReason || "cited + verified"
          : budgetHeld.has(v.src.id)
            ? `Budget reached — payment held to stay within $${budget.toFixed(2)}.`
            : settlementFailed
              ? "release intended but settlement failed — refunded"
              : refusedReason,
        support: v.score,
        confidence: v.confidence, // the Auditor's confidence (P-supported) that graded the payout (#1)
        calibration: confidenceMultiplier(v.src.id), // Bet 4: the self-improving Auditor's learned-reliability multiplier on this source's payout (1.0 = neutral)
        counterfactual: v.release ? undefined : counterfactualFor(v.reasonKind, v.counterfactual), // #2: what would flip a refusal
        provenance: v.span, // #7: the exact source sentence the claim matches (claim → source span → verdict)
        claim: v.cited ? citingSentence(answer, v.src.name) : undefined, // the sentence the source was cited for
        nano: st?.settled ?? 0,
        amount: st?.amount ?? 0,
        tx: st?.tx || undefined, // the USDC settlement: a real 0x tx hash, OR a Gateway batch transfer-id
        onchain: st?.tx ? !!st?.onchain : undefined, // true = a settled on-chain tx; false = batched (resolves when the batch lands)
        // Only emit an explorer LINK for a real on-chain tx — a Gateway batch transfer-id isn't a tx hash
        // and would 404 on arcscan until the batch lands (the tx id above is still carried for reference).
        explorerUrl: st?.onchain && st?.tx ? `${ARC.explorer}/tx/${st.tx}` : undefined,
        // the ERC-8004 reputation write (giveFeedback) tx — so the receipt carries the FULL
        // on-chain footprint per source: the payment AND the portable-reputation update.
        reputationTx: repTx[v.src.id] || undefined,
        // STUB fabricates these hashes, so suppress the link in STUB exactly as the settlement does above —
        // a fake hash must never render as a resolvable arcscan link. The hash is still carried for display.
        reputationUrl: repTx[v.src.id] && !isStub() ? `${ARC.explorer}/tx/${repTx[v.src.id]}` : undefined,
        // the ERC-8004 ValidationRegistry response tx — the Auditor's verdict on the third registry.
        validationTx: valTx[v.src.id] || undefined,
        validationUrl: valTx[v.src.id] && !isStub() ? `${ARC.explorer}/tx/${valTx[v.src.id]}` : undefined,
      };
    });
    const receiptBody = {
      question,
      plan,
      staking,
      counterfactual: attribution,
      budget,
      sources: sourceReceipts,
      crew: crew.map((c) => ({
        name: c.spec.name,
        role: c.spec.role,
        tier: c.spec.tier,
        capability: c.spec.capability,
        price: c.spec.price,
        paid: !!c.paid, // the REAL payment result — not the grade (c.ok)
      })),
      totals: {
        escrowed: ledger.escrowed, // total locked to sources — released + refunded must reconcile to this
        released: ledger.released,
        refunded: ledger.refunded,
        labor: ledger.labor,
        nano: ledger.nano,
        spent: round6(ledger.released + ledger.labor),
        releasedCount: sourceReceipts.filter((s) => s.released).length,
        refusedCount: sourceReceipts.filter((s) => !s.released).length,
      },
    };
    // Sign the receipt with the buyer (the wallet that paid), so "signed, self-proving receipt" is literally
    // true — a judge recovers the signer offline (npm run verify-receipt) and confirms it equals the payer.
    const sig = await signReceipt(receiptBody);
    await emit("summary", sig ? { ...receiptBody, ...sig } : receiptBody);

    // Connect the moat (Bet 1): bind the on-chain escrow RELEASE to the proof-of-citation verdict via
    // MeritJob + MeritVerificationHook. Default OFF (MERIT_HOOK_ONCHAIN != 1) so the run is byte-identical;
    // when on, a verified run RELEASES the escrow and a failed citation makes complete() REVERT (then refunds).
    if (process.env.MERIT_HOOK_ONCHAIN === "1") {
      const verified = receiptBody.totals.releasedCount > 0;
      const proofHash = keccak256(toHex(JSON.stringify(sig ? { ...receiptBody, ...sig } : receiptBody).slice(0, 8000)));
      const deliverableHash = keccak256(toHex(question));
      await emit("phase", { phase: "hook-settle" });
      const gate = await settleViaHook({ amountAtomic: BigInt(1000), verified, deliverableHash, proofHash, description: `merit ${runId}` });
      if (gate)
        await emit("hook-settlement", {
          ...gate,
          note: verified
            ? "on-chain escrow RELEASED — proof-of-citation verified, gated by MeritVerificationHook"
            : "complete() REVERTED by the hook (citation failed), then refunded — the moat enforced on-chain",
        });
    }

    await emit("phase", { phase: "done" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[agent] run failed:", message);
    await emit("error", { message, recoverable: true });
  } finally {
    deleteCtx(runId); // free the shared run context — don't accumulate toward the cap
  }
}

function getMerit(id: string): number {
  return getSources().find((s) => s.id === id)?.merit ?? 0;
}

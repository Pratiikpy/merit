/**
 * @merit/sdk — the in-repo client for the Merit trust layer (#20). Wraps Merit's HTTP API so ANY external
 * agent gets verification + reputation + settlement out of the box — the PRD's tool surface: discover, quote,
 * checkReputation, run (pay-for-verified-work), submitReceipt, openDispute. Pure fetch, no deps; works against
 * a local STUB server or a deployed instance. Publishing to npm is the optional, user-gated step.
 */
export class Merit {
  constructor(baseUrl = process.env.MERIT_BASE || "http://localhost:3000") {
    this.base = baseUrl.replace(/\/$/, "");
  }

  async #json(path, init) {
    const res = await fetch(`${this.base}${path}`, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `${path} → HTTP ${res.status}`);
    return body;
  }

  /** Discover candidate sources for a question. */
  discover(question, budget = 0.5) {
    return this.#json(`/api/sources?question=${encodeURIComponent(question)}&budget=${budget}`);
  }

  /** Rank counterparties (sources/specialists) by on-chain reputation. */
  trust({ kind = "all", role = "", minMerit = 0, limit = 25 } = {}) {
    const q = new URLSearchParams({ kind, role, minMerit: String(minMerit), limit: String(limit) });
    return this.#json(`/api/trust?${q}`);
  }

  /** Read an agent's on-chain, recomputable reputation. */
  checkReputation(agentId) {
    return this.#json(`/api/reputation/${encodeURIComponent(agentId)}`);
  }

  /** A premium quote to guarantee a job, priced by the source's reputation (#17). */
  quote(coverage = 0.05, source = "") {
    return this.#json(`/api/insure?coverage=${coverage}&source=${encodeURIComponent(source)}`);
  }

  /** Pay for a verified research job. Streams the run and returns the signed summary receipt + the events. */
  async run(question, budget = 0.5, opts = {}) {
    const res = await fetch(`${this.base}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, budget, ...opts }),
    });
    if (!res.ok) throw new Error(`run → HTTP ${res.status}`);
    const text = await res.text();
    let receipt = null;
    const events = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const o = JSON.parse(line.slice(5).trim());
        events.push(o);
        if (o && o.sources && o.totals) receipt = o;
      } catch {
        /* heartbeat / non-JSON */
      }
    }
    return { receipt, events };
  }

  /** A receipt is self-proving; this returns how to verify it server-free (the SDK never asks you to trust it). */
  submitReceipt(receipt) {
    return {
      ok: !!receipt,
      verifyWith: "npm run verify-all -- <receipt.json> <buyerAddress>",
      signed: !!(receipt && receipt.signer && receipt.signature),
    };
  }

  /** Appeal a verdict — re-derive the Auditor's judgment on any (source, claim) pair (#dispute path). */
  openDispute(source, claim) {
    return this.#json(`/api/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, claim }),
    });
  }
}

export default Merit;

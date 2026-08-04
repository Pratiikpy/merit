/**
 * @merit/verify — gate any payment on whether the work is actually correct.
 *
 * Merit is a verification-first payment layer on Arc: a claim + its cited source go through a deterministic
 * numeric gate, an NLI factual-consistency check, and an adversarial judge, and come back as a keccak256-signed
 * verdict. This SDK is the one-line integration, designed so the guarantees are CONTRACTS, not conventions:
 *
 *   - `failureMode` is a REQUIRED constructor argument ('fail-open' | 'fail-closed' | 'last-good-verdict').
 *     You pre-commit at design time what happens when the verifier is unreachable — an outage can never
 *     silently flip your agent's payment behavior at 3am.
 *   - Verdict signatures are verified LOCALLY (viem recoverMessageAddress) against a pinned or discovered
 *     signer — you never trust a boolean over the wire.
 *   - `verifyThenPay` uses the server-signed PAYMENT BINDING: the verdict carries
 *     bindingHash = keccak256(canonical {amount, payee, claim, sourceHash}) inside the signed body, and the
 *     SDK recomputes it before your `pay` callback runs — a receipt for $5 to payee A can never authorize
 *     $50 to payee B (anti confused-deputy).
 *
 * Zero dependencies beyond `viem`. The whole SDK is intentionally one file — coding agents can paste it
 * directly (see llms.txt) instead of installing.
 */
import { keccak256, toHex, recoverMessageAddress } from "viem";

export type FailureMode = "fail-open" | "fail-closed" | "last-good-verdict";

export interface Binding {
  amount: number;
  payee: string;
  bindingHash: `0x${string}`;
}

export interface Verdict {
  schema: string;
  claim: string;
  sourceHash: `0x${string}`;
  verdict: "SUPPORTED" | "REFUSED";
  grounded: boolean;
  score: number | null;
  methods: string[];
  reason: string;
  verifiedAt: string;
  binding?: Binding;
  signer?: string;
  signature?: `0x${string}`;
  verificationId?: `0x${string}`;
  [k: string]: unknown;
}

export interface MeritClientOptions {
  /** REQUIRED: what happens when the verifier is unreachable or a check cannot complete.
   *  'fail-closed' → treat as REFUSED (the safe default for money). 'fail-open' → treat as SUPPORTED
   *  (availability over safety — you accept the risk). 'last-good-verdict' → reuse the most recent good
   *  verdict for the SAME claim+source within `lastGoodTtlMs`, else fail closed. */
  failureMode: FailureMode;
  /** Merit deployment to call. Default: the hosted instance. */
  baseUrl?: string;
  /** API key (Authorization: Bearer) for settling tiers; verification itself is keyless. */
  apiKey?: string;
  /** Pin the verdict signer. When omitted, the SDK discovers and caches it from GET /api/verify/signer —
   *  rotation-safe. When the deployment is keyless (unsigned verdicts), signature checks are skipped and
   *  `verifyLocal` reports `signed: false` so you can decide. */
  trustedSigner?: `0x${string}`;
  /** TTL for 'last-good-verdict' reuse (default 10 minutes). */
  lastGoodTtlMs?: number;
  fetchImpl?: typeof fetch;
}

export interface LocalCheck {
  ok: boolean;
  signed: boolean; // was there a signature to check at all?
  signerOk: boolean | null; // null when unsigned
  bindingOk: boolean | null; // null when the verdict carries no binding
  reason: string;
}

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.keys(v as Record<string, unknown>)
          .sort()
          .reduce((acc, k) => {
            const val = (v as Record<string, unknown>)[k];
            if (val !== undefined) acc[k] = sortKeys(val);
            return acc;
          }, {} as Record<string, unknown>)
      : v;

/** Canonical JSON (sorted keys, undefined dropped) — must match the server byte-for-byte. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** The versioned binding-hash spec (v1): keccak256(utf8(canonical {amount, payee, claim, sourceHash})). */
export function computeBindingHash(amount: number, payee: string, claim: string, sourceHash: `0x${string}`): `0x${string}` {
  return keccak256(toHex(canonicalize({ amount, payee, claim, sourceHash })));
}

export class MeritError extends Error {
  constructor(
    message: string,
    public readonly code: "unreachable" | "refused" | "signature" | "binding" | "config",
  ) {
    super(message);
    this.name = "MeritError";
  }
}

export class MeritClient {
  private readonly base: string;
  private readonly mode: FailureMode;
  private readonly apiKey?: string;
  private pinnedSigner?: `0x${string}`;
  private discoveredSigner: `0x${string}` | null | undefined; // undefined = not fetched; null = keyless deployment
  private readonly lastGoodTtl: number;
  private readonly lastGood = new Map<string, { verdict: Verdict; at: number }>();
  private readonly f: typeof fetch;

  constructor(opts: MeritClientOptions) {
    if (!opts || !opts.failureMode) {
      throw new MeritError(
        "failureMode is required: pre-commit 'fail-open' | 'fail-closed' | 'last-good-verdict' at construction so an outage can never silently change your payment behavior",
        "config",
      );
    }
    this.mode = opts.failureMode;
    this.base = (opts.baseUrl || "https://onmerit.xyz").replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.pinnedSigner = opts.trustedSigner;
    this.lastGoodTtl = opts.lastGoodTtlMs ?? 10 * 60_000;
    this.f = opts.fetchImpl || fetch;
  }

  /** The expected verdict signer: the pinned address, else discovered from /api/verify/signer (cached). */
  async trustedSigner(): Promise<`0x${string}` | null> {
    if (this.pinnedSigner) return this.pinnedSigner;
    if (this.discoveredSigner !== undefined) return this.discoveredSigner;
    try {
      const r = await this.f(`${this.base}/api/verify/signer`);
      const d = (await r.json()) as { signer?: string };
      this.discoveredSigner = (d.signer as `0x${string}`) || null;
    } catch {
      this.discoveredSigner = null;
    }
    return this.discoveredSigner;
  }

  /** Verify a claim against a source (or a URL). Returns the server's signed verdict; applies `failureMode`
   *  when the verifier is unreachable. Pass `amount`+`payee` to receive a payment-bound verdict. */
  async verify(
    claim: string,
    source: string,
    opts: { sourceIsUrl?: boolean; amount?: number; payee?: string; depth?: "numeric" | "nli" | "full" } = {},
  ): Promise<Verdict> {
    const key = canonicalize({ claim, source, a: opts.amount, p: opts.payee });
    const body: Record<string, unknown> = { claim, depth: opts.depth };
    if (opts.sourceIsUrl) body.sourceURL = source;
    else body.source = source;
    if (typeof opts.amount === "number" && opts.payee) {
      body.amount = opts.amount;
      body.payee = opts.payee;
    }
    let res: Response;
    try {
      res = await this.f(`${this.base}/api/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return this.degrade(key, `verifier unreachable: ${(e as Error).message}`);
    }
    const data = (await res.json().catch(() => ({}))) as Verdict & { error?: string };
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500 || res.status === 503) return this.degrade(key, data.error || `verifier unavailable (${res.status})`);
      throw new MeritError(data.error || `verify failed (${res.status})`, "refused");
    }
    if (data.verdict === "SUPPORTED") this.lastGood.set(key, { verdict: data, at: Date.now() });
    return data;
  }

  private degrade(key: string, why: string): Verdict {
    if (this.mode === "fail-open") {
      return synthetic("SUPPORTED", `fail-open: ${why} — treating as supported BY YOUR PRE-COMMITTED POLICY`);
    }
    if (this.mode === "last-good-verdict") {
      const lg = this.lastGood.get(key);
      if (lg && Date.now() - lg.at <= this.lastGoodTtl) return { ...lg.verdict, reason: `last-good-verdict (${Math.round((Date.now() - lg.at) / 1000)}s old): ${lg.verdict.reason}` };
      return synthetic("REFUSED", `last-good-verdict: ${why} and no good verdict within TTL — failing closed`);
    }
    return synthetic("REFUSED", `fail-closed: ${why}`);
  }

  /** Verify a verdict LOCALLY: recover the signer over the canonical signed body and (when present) recompute
   *  the payment binding. No network call except signer discovery. Never trusts a boolean. */
  async verifyLocal(verdict: Verdict, expected?: { amount: number; payee: string }): Promise<LocalCheck> {
    // 1) signature
    let signerOk: boolean | null = null;
    let signed = false;
    if (verdict.signature && verdict.signer) {
      signed = true;
      const expectedSigner = await this.trustedSigner();
      const { signer, signature, verificationId: _vid, cached: _c, depth: _d, by: _b, reasoning: _r, settlement: _s, signed: _sg, sourceURL: _u, ...body } = verdict as Record<string, unknown>;
      try {
        const recovered = await recoverMessageAddress({ message: canonicalize(body), signature: signature as `0x${string}` });
        signerOk = recovered === signer && (!expectedSigner || recovered === expectedSigner);
      } catch {
        signerOk = false;
      }
    }
    // 2) binding
    let bindingOk: boolean | null = null;
    if (verdict.binding) {
      const b = verdict.binding;
      const recomputed = computeBindingHash(b.amount, b.payee, verdict.claim, verdict.sourceHash);
      bindingOk = recomputed === b.bindingHash && (!expected || (expected.amount === b.amount && expected.payee === b.payee));
    } else if (expected) {
      bindingOk = false; // a binding was expected but the verdict carries none
    }
    const ok = (signerOk ?? true) && (bindingOk ?? true);
    return {
      ok,
      signed,
      signerOk,
      bindingOk,
      reason: ok
        ? "verdict checks out locally"
        : signerOk === false
          ? "SIGNATURE MISMATCH — do not trust this verdict"
          : "BINDING MISMATCH — this verdict does not authorize this payment",
    };
  }

  /** The paved path: verify with a payment binding, check everything locally, and only then run your `pay`
   *  callback. A REFUSED verdict, a bad signature, or a binding mismatch → `pay` never runs. */
  async verifyThenPay<T>(input: {
    claim: string;
    source: string;
    sourceIsUrl?: boolean;
    amount: number;
    payee: string;
    pay: (verdict: Verdict) => Promise<T> | T;
  }): Promise<{ paid: boolean; verdict: Verdict; check: LocalCheck; result?: T }> {
    const verdict = await this.verify(input.claim, input.source, { sourceIsUrl: input.sourceIsUrl, amount: input.amount, payee: input.payee });
    const check = await this.verifyLocal(verdict, { amount: input.amount, payee: input.payee });
    if (verdict.verdict !== "SUPPORTED") return { paid: false, verdict, check };
    if (verdict.schema === "merit.sdk.synthetic/v1") {
      // fail-open synthesized SUPPORTED: there is no signature or binding to check — pay only under fail-open.
      const result = await input.pay(verdict);
      return { paid: true, verdict, check, result };
    }
    if (!check.ok) throw new MeritError(check.reason, check.bindingOk === false ? "binding" : "signature");
    const result = await input.pay(verdict);
    return { paid: true, verdict, check, result };
  }

  /** The citation toll gate (the moat door): should a per-citation payment release? */
  async gate(input: { claim: string; citedPassage?: string; citedURL?: string; tollUsdc?: number; publisher?: string }): Promise<{
    decision: "release" | "refuse";
    released: number;
    verdict: string;
    verificationId?: string;
    receipt: Record<string, unknown>;
  }> {
    const res = await this.f(`${this.base}/api/toll/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = (await res.json().catch(() => ({}))) as { receipt?: Record<string, unknown>; error?: string };
    if (!res.ok || !data.receipt) throw new MeritError(data.error || `gate failed (${res.status})`, res.status >= 500 ? "unreachable" : "refused");
    const r = data.receipt;
    return {
      decision: r.decision as "release" | "refuse",
      released: (r.released as number) ?? 0,
      verdict: r.verdict as string,
      verificationId: r.verificationId as string | undefined,
      receipt: r,
    };
  }
}

function synthetic(verdict: "SUPPORTED" | "REFUSED", reason: string): Verdict {
  return {
    schema: "merit.sdk.synthetic/v1", // clearly labeled: this verdict was synthesized by YOUR failure policy, not by the verifier
    claim: "",
    sourceHash: "0x" as `0x${string}`,
    verdict,
    grounded: verdict === "SUPPORTED",
    score: null,
    methods: ["failure-mode"],
    reason,
    verifiedAt: new Date().toISOString(),
  };
}

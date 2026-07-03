/**
 * Verdict-carrying payment webhooks (Wave A #4) — turns settlement plumbing into verification-receipt
 * distribution. When a citation settles, is refused, or a toll pauses, Merit POSTs a SIGNED event whose payload
 * carries the VERDICT and the REASON (settled-because-verified vs refused-because-unsupported vs budget-paused),
 * so an integrator reacts to *why* money did or didn't move — not just that it did.
 *
 * Signing: each endpoint's secret is DERIVED (`HMAC(signingKey, "whsec:"+id)`), so no secret is ever stored —
 * the store holds only the id + url. The delivery carries `Merit-Signature: t=<unix>,v1=<hmac>` where the HMAC
 * is over `"<t>.<body>"`; the receiver recomputes it with the secret shown once at registration (Stripe-style).
 * Delivery is SSRF-guarded (shared lib/ssrf guard, re-validated per delivery) and best-effort; an endpoint that
 * fails repeatedly is auto-disabled so a dead URL never blocks settlement. Payloads carry only public data (the
 * same claim preview / verdict / amount surfaced on /proof) — no source text, no keys.
 */
import { createHmac, randomBytes } from "node:crypto";
import { loadDocFresh, loadDocFromMirror, saveDoc } from "./store";
import { assertPublicUrl, guardedFetch } from "./ssrf";
import { isStub } from "./arc";

interface Hook {
  id: string;
  url: string;
  principalId?: string; // when auth is on, the owning principal (events scoped to it)
  events: string[]; // subscribed event types, or ["*"] for all
  createdAt: string;
  disabled?: boolean;
  failures: number; // consecutive delivery failures
  lastAt?: string;
  lastStatus?: number | string;
}
interface HookLog {
  hooks: Record<string, Hook>;
}

const DOC = "webhooks";
const MAX_HOOKS = 500;
const DISABLE_AFTER = 8; // consecutive failures → auto-disable a dead endpoint

function signingKey(): string {
  const k = process.env.MERIT_WEBHOOK_SIGNING_KEY || process.env.MERIT_SIGNING_KEY;
  if (k) return k;
  // A public fallback constant would let anyone derive an endpoint's secret from its id and forge a valid
  // signature — so on a real (STUB=0) deploy we FAIL CLOSED rather than sign with a known key. On prod
  // MERIT_SIGNING_KEY is always set (it signs receipts), so this only trips a genuine misconfiguration.
  if (!isStub()) throw new Error("webhook signing not configured — set MERIT_WEBHOOK_SIGNING_KEY (or MERIT_SIGNING_KEY)");
  return "merit-dev-webhook-key"; // dev/demo only (keyless STUB), never a real deploy
}
/** The per-endpoint secret, DERIVED (never stored) so it's stable across instances and recomputable at delivery. */
export function webhookSecret(id: string): string {
  return createHmac("sha256", signingKey()).update("whsec:" + id).digest("hex");
}
/** The signature a receiver must recompute: HMAC(secret, `${t}.${body}`). Exported for the offline verifier + tests. */
export function signPayload(id: string, t: number, body: string): string {
  return createHmac("sha256", webhookSecret(id)).update(`${t}.${body}`).digest("hex");
}

let cache: HookLog | null = null;
function load(): HookLog {
  if (cache) return cache;
  const { value, cacheable } = loadDocFresh<HookLog>(DOC, { hooks: {} });
  if (!value.hooks) value.hooks = {};
  if (cacheable) cache = value;
  return value;
}
export async function refreshWebhooksFromMirror(): Promise<void> {
  const v = await loadDocFromMirror<HookLog>(DOC);
  if (v && typeof v === "object") {
    if (!v.hooks) v.hooks = {};
    cache = v;
  }
}

export interface PublicHook {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
  disabled: boolean;
  failures: number;
  lastAt?: string;
  lastStatus?: number | string;
}
function pub(h: Hook): PublicHook {
  return { id: h.id, url: h.url, events: h.events, createdAt: h.createdAt, disabled: !!h.disabled, failures: h.failures, lastAt: h.lastAt, lastStatus: h.lastStatus };
}

/** Register a webhook. Validates the URL is a PUBLIC http(s) target (throws otherwise → the route returns 400).
 *  Returns the derived secret ONCE — it is never stored and can only be re-shown by re-deriving with the key. */
export async function registerWebhook(url: string, opts?: { principalId?: string; events?: string[] }): Promise<{ id: string; url: string; secret: string }> {
  const u = await assertPublicUrl(url); // SSRF: reject localhost / private / IPv6-loopback / DNS→private
  const log = load();
  if (Object.keys(log.hooks).length >= MAX_HOOKS) {
    // Evict the oldest to stay bounded.
    const oldest = Object.values(log.hooks).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
    if (oldest) delete log.hooks[oldest.id];
  }
  const id = "wh_" + randomBytes(8).toString("hex");
  const events = opts?.events?.length ? opts.events.map((e) => e.trim()).filter(Boolean) : ["*"];
  log.hooks[id] = { id, url: u.toString(), principalId: opts?.principalId, events, createdAt: new Date().toISOString(), failures: 0 };
  cache = log;
  saveDoc(DOC, log);
  return { id, url: u.toString(), secret: webhookSecret(id) };
}

export function listWebhooks(principalId?: string): PublicHook[] {
  return Object.values(load().hooks)
    .filter((h) => (principalId ? h.principalId === principalId : true))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(pub);
}

export function removeWebhook(id: string, principalId?: string): boolean {
  const log = load();
  const h = log.hooks[id];
  if (!h) return false;
  if (principalId && h.principalId !== principalId) return false; // can't delete another principal's hook
  delete log.hooks[id];
  cache = log;
  saveDoc(DOC, log);
  return true;
}

export interface WebhookEvent {
  type: string; // e.g. "citation.settled" | "citation.refused" | "toll.paused" | "citation.verified"
  at: string;
  [k: string]: unknown;
}
function matches(h: Hook, type: string): boolean {
  return !h.disabled && (h.events.includes("*") || h.events.includes(type));
}

/**
 * Deliver an event to every subscribed webhook — signed, SSRF-guarded, best-effort, timeout-bounded. Never
 * throws into the caller (a settlement must not fail because a receiver is down). Auto-disables an endpoint
 * after DISABLE_AFTER consecutive failures. Call it fire-and-forget (or await if you want delivery before the
 * serverless function freezes; the API routes await it under a short timeout).
 */
export async function emitWebhookEvent(event: WebhookEvent, opts?: { principalId?: string }): Promise<void> {
  try {
    const log = load();
    const targets = Object.values(log.hooks).filter(
      (h) => matches(h, event.type) && (opts?.principalId ? h.principalId === opts.principalId || !h.principalId : true),
    );
    if (!targets.length) return;
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    await Promise.all(
      targets.map(async (h) => {
        try {
          const sig = signPayload(h.id, t, body);
          const r = await guardedFetch(h.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "merit-signature": `t=${t},v1=${sig}`,
              "merit-event": event.type,
              "user-agent": "merit-webhooks/1",
            },
            body,
            timeoutMs: 8000,
          });
          h.failures = 0;
          h.lastStatus = r.status;
        } catch (e) {
          h.failures = (h.failures || 0) + 1;
          h.lastStatus = (e as Error).message.slice(0, 60);
          if (h.failures >= DISABLE_AFTER) h.disabled = true;
        }
        h.lastAt = new Date().toISOString();
      }),
    );
    cache = log;
    saveDoc(DOC, log);
  } catch (e) {
    console.error("[webhooks] emit failed:", (e as Error).message);
  }
}

/** Test seam. */
export function _resetWebhooks(): void {
  cache = null;
}

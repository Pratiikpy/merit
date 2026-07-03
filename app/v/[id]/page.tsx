import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Hanken_Grotesk, IBM_Plex_Mono } from "next/font/google";
import { getCard, refreshCardsFromMirror, type VerifyCard } from "@/lib/cards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sans = Hanken_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], display: "swap" });

async function load(id: string): Promise<VerifyCard | undefined> {
  await refreshCardsFromMirror().catch(() => {});
  return getCard(id);
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const c = await load(id);
  if (!c) return { title: "Receipt not found — Merit" };
  const claim = c.claim.length > 100 ? c.claim.slice(0, 100) + "…" : c.claim;
  const verb = c.verdict === "SUPPORTED" ? "✓ VERIFIED" : "✕ REFUSED";
  return {
    title: `${verb} — Merit proof-of-citation receipt`,
    description: `"${claim}" — ${c.reason}`,
    openGraph: { title: `${verb}: "${claim}"`, description: c.reason, type: "article" },
    twitter: { card: "summary_large_image", title: `${verb}: "${claim}"`, description: c.reason },
  };
}

const INK = "#0A0A0A", SLATE = "#4B5563", MUTED = "#6B7280", LINE = "#ECECEE";
const GREEN = "#047857", RED = "#BE123C";

/** A card's sourceUrl can be arbitrary text (e.g. a scheme-less RSS <link>). Parse defensively so a malformed
 *  value renders as no-link instead of throwing `new URL` and 500-ing the whole receipt. */
function safeHost(u?: string): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return /^https?:$/.test(p.protocol) ? p.hostname : null;
  } catch {
    return null;
  }
}

function Chip({ state }: { state: "pass" | "fail" | "na" }) {
  const s = state === "pass"
    ? { bg: "#DCFCE7", fg: GREEN, t: "PASS" }
    : state === "fail"
      ? { bg: "#FEE2E2", fg: RED, t: "FAIL" }
      : { bg: "#F3F4F6", fg: MUTED, t: "—" };
  return <span style={{ flex: "none", fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999, background: s.bg, color: s.fg, marginTop: 1 }}>{s.t}</span>;
}

function Gate({ name, state, detail }: { name: string; state: "pass" | "fail" | "na"; detail: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 11, border: `1px solid ${LINE}`, borderRadius: 11, padding: "11px 13px" }}>
      <Chip state={state} />
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>{name}</div>
        <div style={{ fontSize: 12.5, color: SLATE, marginTop: 2 }}>{detail}</div>
      </div>
    </div>
  );
}

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await load(id);
  if (!c) notFound();

  const sup = c.verdict === "SUPPORTED";
  const g = c.gates;
  type GateView = { state: "pass" | "fail" | "na"; d: string };
  const numeric: GateView = g?.numeric?.ran ? { state: g.numeric.pass ? "pass" : "fail", d: g.numeric.detail } : { state: "na", d: "no numbers to check in this claim" };
  const nli: GateView = g?.nli?.ran ? { state: g.nli.pass === true ? "pass" : g.nli.pass === false ? "fail" : "na", d: g.nli.detail } : { state: "na", d: "not run on this deployment" };
  const judge: GateView = g?.judge?.ran ? { state: g.judge.verdict === "support" ? "pass" : "fail", d: g.judge.reason } : { state: "na", d: "not run (keyless) — a fabricated figure is still caught deterministically" };
  const srcHost = safeHost(c.sourceUrl);
  // Only assert offline recovery when the receipt actually carries the full signed body (older cards predate it).
  const recoverable = !!(c.signer && c.signature && c.schema && c.engineVersion && c.sourceHash && c.verifiedAt && c.gates);

  return (
    <div className={sans.className} style={{ background: "#FFFFFF", color: INK, minHeight: "100vh", padding: "0 24px" }}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <nav style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 0", borderBottom: `1px solid ${LINE}` }}>
          <a href="/" style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 700, fontSize: 19, letterSpacing: "-.02em", textDecoration: "none", color: INK }}>
            <span style={{ width: 30, height: 30, borderRadius: 8, background: INK, display: "inline-flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px rgba(10,10,10,.4)" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6.5 17 L6.5 7.5 L12 14 L17.5 7.5 L17.5 17" /><path d="M14.7 10.1 L17.5 7 L17.5 9.8" /></svg>
            </span>
            Merit
          </a>
          <span style={{ fontSize: 13, color: MUTED, fontWeight: 600 }}>Proof-of-citation receipt</span>
        </nav>

        <div style={{ margin: "34px 0 60px" }}>
          {/* Verdict stamp */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, borderRadius: 16, padding: "18px 20px", marginBottom: 18, border: `1px solid ${sup ? "#A7F3D0" : "#FECDD3"}`, background: sup ? "#ECFDF5" : "#FFF1F2" }}>
            <span style={{ width: 44, height: 44, flex: "none", borderRadius: 12, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 700, color: "#fff", background: sup ? GREEN : RED }}>{sup ? "✓" : "✕"}</span>
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em", color: sup ? "#065F46" : "#9F1239", margin: 0, lineHeight: 1.1 }}>{sup ? "SUPPORTED" : "REFUSED"}</h1>
              <div style={{ fontSize: 13.5, color: SLATE, marginTop: 2 }}>{c.reason}</div>
            </div>
          </div>

          {/* Claim */}
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: MUTED, margin: "0 0 8px" }}>The claim</div>
          <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.4, borderLeft: `3px solid ${INK}`, padding: "2px 0 2px 14px", marginBottom: 20 }}>{c.claim}</div>

          {/* Source */}
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: MUTED, margin: "0 0 8px" }}>
            The source{c.sourceName ? ` · ${c.sourceName}` : ""}{srcHost ? <> · <a href={c.sourceUrl} target="_blank" rel="noopener" style={{ color: MUTED, textDecoration: "underline" }}>{srcHost} ↗</a></> : ""}
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.6, color: SLATE, background: "#FAFAFA", border: `1px solid ${LINE}`, borderRadius: 11, padding: "12px 14px", marginBottom: 22 }}>{c.sourcePreview}{c.sourcePreview.length >= 600 ? "…" : ""}</div>

          {/* Gates */}
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: MUTED, margin: "0 0 10px" }}>Three gates decided it</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Gate name="Deterministic numeric verifier" state={numeric.state} detail={numeric.d} />
            <Gate name="Factual-consistency (NLI) gate" state={nli.state} detail={nli.d} />
            <Gate name="Adversarial LLM judge" state={judge.state} detail={judge.d} />
          </div>

          {/* Settlement, split accrual, or single custody accrual — never conflate them (an accrual moved no
              on-chain money; a split went to the contributors, NOT to the collective's custody). */}
          {typeof c.paidUsdc === "number" && c.paidUsdc > 0 && (
            <div style={{ marginTop: 18, border: `1px solid #A7F3D0`, background: "#ECFDF5", borderRadius: 12, padding: "13px 15px" }}>
              {c.splits && c.splits.length > 0 ? (
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: "#065F46" }}>
                    ${c.paidUsdc.toFixed(4)} USDC split across {c.splits.length} contributor{c.splits.length > 1 ? "s" : ""} — each share accrued to its own Merit custody, claimable on-chain via domain proof
                  </div>
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                    {c.splits.map((sp, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 12.5, color: "#065F46", gap: 12 }}>
                        <span style={{ fontWeight: 600 }}>{sp.name}</span>
                        <span className={mono.className}>${sp.amount.toFixed(4)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: "#065F46" }}>
                    {c.custody
                      ? `$${c.paidUsdc.toFixed(4)} USDC accrued to ${c.sourceName || "the creator"}'s Merit custody — claimable on-chain via domain proof`
                      : `$${c.paidUsdc.toFixed(4)} USDC settled to ${c.sourceName || "the source"}`}
                  </span>
                  {!c.custody && (c.explorerUrl ? <a href={c.explorerUrl} target="_blank" rel="noopener" className={mono.className} style={{ fontSize: 12, color: GREEN, textDecoration: "underline" }}>on-chain ↗</a> : c.tx ? <span className={mono.className} style={{ fontSize: 12, color: MUTED }}>batched · transfer {c.tx.slice(0, 12)}…</span> : null)}
                </div>
              )}
            </div>
          )}

          {/* Signature + provenance */}
          {c.signer && (
            <div className={mono.className} style={{ fontSize: 11.5, color: MUTED, marginTop: 16, lineHeight: 1.6 }}>
              Signed by {c.signer} · verifier {c.modelTag} · {new Date(c.createdAt).toISOString().replace("T", " ").slice(0, 19)} UTC
              {recoverable ? (
                <>
                  <br />Recover the signer offline — no need to trust Merit&apos;s server: <span style={{ color: SLATE }}>GET /api/card/{c.id}</span> → the <span style={{ color: SLATE }}>signed</span> object → <span style={{ color: SLATE }}>scripts/verify-receipt.mjs</span> recovers this exact address.
                </>
              ) : null}
            </div>
          )}

          {/* CTA */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 26 }}>
            <a href="/verify.html" style={{ fontSize: 15, fontWeight: 600, color: "#fff", background: INK, padding: "12px 20px", borderRadius: 10, textDecoration: "none", boxShadow: "0 4px 12px rgba(10,10,10,.26)" }}>Verify a claim yourself →</a>
            <a href="/" style={{ fontSize: 15, fontWeight: 600, color: INK, background: "#fff", border: `1px solid #E4E4E7`, padding: "12px 20px", borderRadius: 10, textDecoration: "none" }}>How Merit works</a>
          </div>
        </div>

        <footer style={{ borderTop: `1px solid ${LINE}`, padding: "22px 0", fontSize: 12, color: MUTED }}>Merit — payment gated on reproducible verified support, not appearance. Every citation is a signed, checkable receipt.</footer>
      </div>
    </div>
  );
}

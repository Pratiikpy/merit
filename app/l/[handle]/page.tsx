import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Hanken_Grotesk, IBM_Plex_Mono } from "next/font/google";
import { refreshRegistryFromMirror, resolveSourceRef, type Source } from "@/lib/registry";
import { effectivePrice } from "@/lib/pricing";
import { learnedTrust, historyStats } from "@/lib/history";
import { custodyUnclaimed } from "@/lib/custody";
import CiteBox from "./CiteBox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sans = Hanken_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], display: "swap" });

const INK = "#0A0A0A", SLATE = "#4B5563", MUTED = "#6B7280", LINE = "#ECECEE", GREEN = "#047857";

function originBase(): string {
  if (process.env.MERIT_ORIGIN) return process.env.MERIT_ORIGIN.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "";
}

async function load(handle: string): Promise<Source | undefined> {
  await refreshRegistryFromMirror().catch(() => {});
  return resolveSourceRef(handle);
}

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const s = await load(handle);
  if (!s) return { title: "Creator not found — Merit" };
  const price = effectivePrice(s.price, s.merit, s.priceMode);
  const title = `Cite ${s.name} on Merit — paid only if verified`;
  const description = `${s.name} (${s.handle}) is paid $${price.toFixed(4)} per citation — but only for citations that pass Merit's three-gate verifier. Cite them and settle real USDC on Arc.`;
  return { title, description, openGraph: { title, description, type: "profile" }, twitter: { card: "summary_large_image", title, description } };
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: MUTED }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-.01em", marginTop: 3 }}>{value}</div>
      {sub ? <div style={{ fontSize: 11.5, color: MUTED, marginTop: 1 }}>{sub}</div> : null}
    </div>
  );
}

export default async function MeritLinkPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const s = await load(handle);
  if (!s) notFound();

  const price = effectivePrice(s.price, s.merit, s.priceMode);
  const trust = learnedTrust(s.id); // 0.5 = unseen/neutral
  const stats = historyStats(s.id);
  const unclaimed = s.custodial ? custodyUnclaimed(s.id) : 0;
  const stub = !process.env.BUYER_PRIVATE_KEY || process.env.STUB === "1";

  const base = originBase();
  const pageUrl = `${base}/l/${s.id}`;
  const qrSrc = `/api/qr?data=${encodeURIComponent(pageUrl || `/l/${s.id}`)}`;
  const embed = `<a href="${pageUrl || `/l/${s.id}`}">Cite me on Merit — paid only if the citation verifies</a>`;

  return (
    <div className={sans.className} style={{ background: "#FFFFFF", color: INK, minHeight: "100vh", padding: "0 24px" }}>
      <div style={{ maxWidth: 680, margin: "0 auto" }}>
        <nav style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 0", borderBottom: `1px solid ${LINE}` }}>
          <a href="/" style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 700, fontSize: 19, letterSpacing: "-.02em", textDecoration: "none", color: INK }}>
            <span style={{ width: 30, height: 30, borderRadius: 8, background: INK, display: "inline-flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px rgba(10,10,10,.4)" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6.5 17 L6.5 7.5 L12 14 L17.5 7.5 L17.5 17" /><path d="M14.7 10.1 L17.5 7 L17.5 9.8" /></svg>
            </span>
            Merit
          </a>
          <span style={{ fontSize: 13, color: MUTED, fontWeight: 600 }}>Merit Link · citation toll</span>
        </nav>

        <div style={{ margin: "30px 0 60px" }}>
          {/* Creator identity */}
          <div style={{ display: "flex", alignItems: "center", gap: 15, marginBottom: 22 }}>
            <span style={{ width: 56, height: 56, flex: "none", borderRadius: 14, background: s.avatarBg, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 21, fontWeight: 700, letterSpacing: "-.01em" }}>{s.initials}</span>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.02em", margin: 0, lineHeight: 1.1 }}>{s.name}</h1>
                {s.verified ? <span style={{ fontSize: 11, fontWeight: 700, color: GREEN, background: "#ECFDF5", border: "1px solid #A7F3D0", padding: "2px 9px", borderRadius: 999 }}>verified identity</span> : <span style={{ fontSize: 11, fontWeight: 700, color: MUTED, background: "#F3F4F6", padding: "2px 9px", borderRadius: 999 }}>unverified</span>}
              </div>
              <div className={mono.className} style={{ fontSize: 13, color: MUTED, marginTop: 3 }}>{s.handle} · {s.kind}</div>
            </div>
          </div>

          <p style={{ fontSize: 16, lineHeight: 1.55, color: SLATE, margin: "0 0 22px" }}>
            This is <strong style={{ color: INK }}>{s.name}</strong>&apos;s Merit Link. Anyone can cite them here — Merit runs the
            citation through its three-gate verifier and <strong style={{ color: INK }}>settles payment only if the source actually supports the claim</strong>.
            A cited-but-unsupported claim pays nothing. That is the entire point: attribution you can trust, and money that only moves for real citations.
          </p>

          {/* Stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 26 }}>
            <Stat label="Price / citation" value={`$${price.toFixed(4)}`} sub={s.priceMode === "merit-gated" ? "merit-gated" : "fixed"} />
            <Stat label="Merit" value={String(s.merit)} sub="reputation (0–100)" />
            <Stat label="Verified release rate" value={`${Math.round(trust * 100)}%`} sub={stats.runs ? `${stats.runs} settlement${stats.runs > 1 ? "s" : ""} on record` : "no history yet — neutral"} />
          </div>

          {/* The toll */}
          <div style={{ border: `1px solid ${LINE}`, borderRadius: 16, padding: "20px 20px 22px", marginBottom: 26, boxShadow: "0 1px 3px rgba(10,10,10,.04)" }}>
            <CiteBox handle={s.id} price={price} custodial={!!s.custodial} stub={stub} />
          </div>

          {/* Multi-author split note */}
          {s.splits && s.splits.length > 0 && (
            <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, padding: "13px 15px", marginBottom: 26, fontSize: 13, color: SLATE, lineHeight: 1.55 }}>
              A verified citation&apos;s payment is <strong style={{ color: INK }}>split across {s.splits.length} contributors</strong> ({s.splits.map((x) => x.name).join(", ")}), each claimable via domain proof — strictly downstream of the verify gate, so a refused citation splits nothing.
            </div>
          )}

          {/* Custody note */}
          {s.custodial && (
            <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, padding: "13px 15px", marginBottom: 26, fontSize: 13, color: SLATE, lineHeight: 1.55 }}>
              This creator onboarded without their own wallet, so verified earnings accrue to <strong style={{ color: INK }}>Merit custody</strong> and are claimable on-chain once they prove domain ownership.
              {unclaimed > 0 ? <> Currently <strong style={{ color: GREEN }}>${unclaimed.toFixed(4)} USDC</strong> unclaimed.</> : null}
            </div>
          )}

          {/* Share: QR + embed */}
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 20, alignItems: "center", border: `1px solid ${LINE}`, borderRadius: 16, padding: "18px 20px" }}>
            <img src={qrSrc} alt={`QR code linking to ${s.name}'s Merit Link`} width={116} height={116} style={{ display: "block", borderRadius: 10, border: `1px solid ${LINE}` }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 5 }}>Share this Merit Link</div>
              <div style={{ fontSize: 13, color: SLATE, lineHeight: 1.5, marginBottom: 11 }}>Scan the code to open this toll and settle on the spot, or embed the link on the creator&apos;s site:</div>
              <code className={mono.className} style={{ display: "block", fontSize: 11.5, color: INK, background: "#FAFAFA", border: `1px solid ${LINE}`, borderRadius: 8, padding: "9px 11px", overflowX: "auto", whiteSpace: "pre" }}>{embed}</code>
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 26 }}>
            <a href="/verify.html" style={{ fontSize: 15, fontWeight: 600, color: "#fff", background: INK, padding: "12px 20px", borderRadius: 10, textDecoration: "none", boxShadow: "0 4px 12px rgba(10,10,10,.26)" }}>Verify any claim →</a>
            <a href="/" style={{ fontSize: 15, fontWeight: 600, color: INK, background: "#fff", border: `1px solid #E4E4E7`, padding: "12px 20px", borderRadius: 10, textDecoration: "none" }}>How Merit works</a>
          </div>
        </div>

        <footer style={{ borderTop: `1px solid ${LINE}`, padding: "22px 0", fontSize: 12, color: MUTED }}>Merit — payment gated on reproducible verified support, not appearance. Every citation is a signed, checkable receipt.</footer>
      </div>
    </div>
  );
}

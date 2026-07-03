"use client";

import { useState } from "react";

const INK = "#0A0A0A", SLATE = "#4B5563", MUTED = "#6B7280", LINE = "#ECECEE";
const GREEN = "#047857", RED = "#BE123C";

interface Gate {
  ran: boolean;
  pass?: boolean | null;
  verdict?: "support" | "refute" | null;
  detail?: string;
  reason?: string;
  score?: number | null;
}
interface Result {
  id: string;
  url: string;
  verdict: "SUPPORTED" | "REFUSED";
  reason: string;
  gates?: { numeric: Gate; nli: Gate; judge: Gate };
  price: number;
  settled?: {
    amount?: number;
    tx?: string;
    explorerUrl?: string;
    onchain?: boolean;
    custody?: boolean;
    stub?: boolean;
    paused?: boolean;
    error?: string;
    splits?: Array<{ name: string; amount: number; weight: number }>;
  } | null;
}

function chip(state: "pass" | "fail" | "na") {
  const s =
    state === "pass" ? { bg: "#DCFCE7", fg: GREEN, t: "PASS" } : state === "fail" ? { bg: "#FEE2E2", fg: RED, t: "FAIL" } : { bg: "#F3F4F6", fg: MUTED, t: "—" };
  return (
    <span style={{ flex: "none", fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: s.bg, color: s.fg }}>{s.t}</span>
  );
}

function GateRow({ name, state, detail }: { name: string; state: "pass" | "fail" | "na"; detail: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "7px 0" }}>
      {chip(state)}
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{name}</div>
        {detail ? <div style={{ fontSize: 12, color: SLATE, marginTop: 1 }}>{detail}</div> : null}
      </div>
    </div>
  );
}

export default function CiteBox({
  handle,
  price,
  custodial,
  stub,
}: {
  handle: string;
  price: number;
  custodial: boolean;
  stub: boolean;
}) {
  const [claim, setClaim] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const c = claim.trim();
    if (!c || loading) return;
    setLoading(true);
    setError("");
    setRes(null);
    setCopied(false);
    try {
      const r = await fetch(`/api/link/${encodeURIComponent(handle)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim: c }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data?.error || `request failed (${r.status})`);
      } else {
        setRes(data as Result);
      }
    } catch {
      setError("network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  const sup = res?.verdict === "SUPPORTED";
  const st = res?.settled;
  const g = res?.gates;
  const numericState = g?.numeric?.ran ? (g.numeric.pass ? "pass" : "fail") : "na";
  const nliState = g?.nli?.ran ? (g.nli.pass === true ? "pass" : g.nli.pass === false ? "fail" : "na") : "na";
  const judgeState = g?.judge?.ran ? (g.judge.verdict === "support" ? "pass" : "fail") : "na";

  return (
    <div>
      <form onSubmit={submit}>
        <label htmlFor="claim" style={{ display: "block", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: MUTED, marginBottom: 8 }}>
          The claim you want to attribute to this creator
        </label>
        <textarea
          id="claim"
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          placeholder="e.g. Cross-border B2B stablecoin settlement crossed $4.1T in annualized volume in 2026."
          rows={3}
          style={{
            width: "100%",
            fontSize: 15,
            lineHeight: 1.5,
            padding: "12px 14px",
            border: `1px solid #D8D8DC`,
            borderRadius: 11,
            resize: "vertical",
            fontFamily: "inherit",
            color: INK,
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <button
          type="submit"
          disabled={loading || !claim.trim()}
          style={{
            marginTop: 12,
            fontSize: 15,
            fontWeight: 600,
            color: "#fff",
            background: loading || !claim.trim() ? "#9CA3AF" : INK,
            border: "none",
            padding: "12px 22px",
            borderRadius: 10,
            cursor: loading || !claim.trim() ? "default" : "pointer",
            boxShadow: loading || !claim.trim() ? "none" : "0 4px 12px rgba(10,10,10,.26)",
          }}
        >
          {loading ? "Verifying the citation…" : `Cite & settle · $${price.toFixed(4)}`}
        </button>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 9, lineHeight: 1.5 }}>
          Merit runs the full verifier and pays this creator{" "}
          <strong style={{ color: SLATE }}>only if the citation actually checks out</strong>.
          {custodial ? " Earnings accrue to Merit custody, claimable on-chain via domain proof." : stub ? " This deployment is keyless — verification is real; settlement is simulated." : " A passing citation settles real USDC to their wallet on Arc."}
        </div>
      </form>

      {error && (
        <div style={{ marginTop: 16, border: `1px solid #FECDD3`, background: "#FFF1F2", borderRadius: 11, padding: "12px 14px", fontSize: 13.5, color: "#9F1239" }}>
          {error}
        </div>
      )}

      {res && (
        <div style={{ marginTop: 18, border: `1px solid ${sup ? "#A7F3D0" : "#FECDD3"}`, background: sup ? "#ECFDF5" : "#FFF1F2", borderRadius: 14, padding: "16px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 10 }}>
            <span style={{ width: 34, height: 34, flex: "none", borderRadius: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: "#fff", background: sup ? GREEN : RED }}>{sup ? "✓" : "✕"}</span>
            <div>
              <div style={{ fontSize: 17, fontWeight: 800, color: sup ? "#065F46" : "#9F1239" }}>{sup ? "SUPPORTED" : "REFUSED"}</div>
              <div style={{ fontSize: 12.5, color: SLATE }}>{res.reason}</div>
            </div>
          </div>

          <div style={{ borderTop: `1px solid ${sup ? "#BBF7D0" : "#FECDD3"}`, paddingTop: 6 }}>
            <GateRow name="Deterministic numeric verifier" state={numericState} detail={g?.numeric?.detail || ""} />
            <GateRow name="Factual-consistency (NLI) gate" state={nliState} detail={g?.nli?.detail || ""} />
            <GateRow name="Adversarial LLM judge" state={judgeState} detail={g?.judge?.reason || ""} />
          </div>

          {/* settlement line */}
          {sup && st && (
            <div style={{ marginTop: 10, borderTop: `1px solid #BBF7D0`, paddingTop: 12, fontSize: 13.5, fontWeight: 600, color: "#065F46" }}>
              {st.error
                ? <span style={{ color: "#9F1239", fontWeight: 500 }}>Citation verified, but on-chain settlement failed: {st.error}</span>
                : st.paused
                  ? <span style={{ color: SLATE, fontWeight: 500 }}>Citation verified. The public toll budget for today is spent — settlement paused (no payment made).</span>
                  : st.stub
                    ? <span style={{ color: SLATE, fontWeight: 500 }}>Citation verified. ${st.amount?.toFixed(4)} would settle to this creator (simulated — keyless deployment).</span>
                    : st.splits && st.splits.length
                      ? <>${st.amount?.toFixed(4)} USDC split across {st.splits.length} contributors — each claimable via domain proof:
                          <span style={{ display: "block", marginTop: 6, fontWeight: 500 }}>
                            {st.splits.map((sp, i) => (
                              <span key={i} style={{ display: "block", fontSize: 12.5, color: SLATE }}>· {sp.name} — ${sp.amount.toFixed(4)} ({Math.round(sp.weight * 100)}%)</span>
                            ))}
                          </span>
                        </>
                    : st.custody
                      ? <>${st.amount?.toFixed(4)} USDC accrued to this creator&apos;s Merit custody — claimable on-chain via domain proof.</>
                      : <>
                          ${st.amount?.toFixed(4)} USDC settled on Arc.{" "}
                          {st.explorerUrl
                            ? <a href={st.explorerUrl} target="_blank" rel="noopener" style={{ color: GREEN, textDecoration: "underline" }}>on-chain ↗</a>
                            : st.tx
                              ? <span style={{ color: MUTED, fontWeight: 500 }}>batched · transfer {String(st.tx).slice(0, 12)}…</span>
                              : null}
                        </>}
            </div>
          )}
          {!sup && (
            <div style={{ marginTop: 10, borderTop: `1px solid #FECDD3`, paddingTop: 12, fontSize: 13.5, color: SLATE }}>
              No payment made — Merit refuses to pay a citation the source doesn&apos;t support. That refusal is the product.
            </div>
          )}

          {/* receipt permalink */}
          {res.url && (
            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <a href={res.url} style={{ fontSize: 13, fontWeight: 600, color: INK, textDecoration: "underline" }}>Open the signed receipt →</a>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(res.url).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  });
                }}
                style={{ fontSize: 12, fontWeight: 600, color: SLATE, background: "#fff", border: `1px solid ${LINE}`, padding: "5px 11px", borderRadius: 8, cursor: "pointer" }}
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

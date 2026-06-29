// Branded 404 — keeps the Merit chrome (mark + a way home) instead of the bare
// Next.js default, so a mistyped or stale link never dead-ends off-brand.
import Link from "next/link";

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        padding: "0 24px",
        textAlign: "center",
        background: "#FFFFFF",
        color: "#0A0A0A",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          width: 44,
          height: 44,
          borderRadius: 11,
          background: "#0A0A0A",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 2px 6px rgba(10,10,10,.4)",
        }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M6.5 17 L6.5 7.5 L12 14 L17.5 7.5 L17.5 17" />
          <path d="M14.7 10.1 L17.5 7 L17.5 9.8" />
        </svg>
      </span>
      <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "#6B7280" }}>
        404 — page not found
      </div>
      <h1 style={{ fontSize: 34, lineHeight: 1.1, letterSpacing: "-.03em", fontWeight: 800, margin: 0, maxWidth: "18ch" }}>
        This page doesn&apos;t exist.
      </h1>
      <p style={{ fontSize: 17, lineHeight: 1.55, color: "#52525B", margin: 0, maxWidth: "44ch" }}>
        The link may be stale. Head back to the live demo, where the agent pays creators only for citations that verify.
      </p>
      <Link
        href="/"
        style={{
          marginTop: 6,
          fontSize: 15,
          fontWeight: 600,
          color: "#fff",
          background: "#0A0A0A",
          padding: "12px 22px",
          borderRadius: 10,
          textDecoration: "none",
          boxShadow: "0 1px 2px rgba(16,24,40,.12),0 6px 16px rgba(10,10,10,.3)",
        }}
      >
        ← Back to Merit
      </Link>
    </div>
  );
}

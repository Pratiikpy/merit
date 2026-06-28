import { NextRequest } from "next/server";
import { getSources } from "@/lib/registry";
import { normalizeDomain } from "@/lib/passport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/badge?domain=<host> — an embeddable "Cited by AI — Verified by Merit" SVG badge. It is independently
// FALSIFIABLE: it resolves the domain against Merit's live registry, so a site can't fake a "verified" badge for
// a domain that hasn't proven ownership. (A self-report agent's badge can't do this — its "citation" is one LLM
// grading itself, so any site could claim it and no reader could check.)
function esc(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

export async function GET(req: NextRequest) {
  const domain = normalizeDomain(req.nextUrl.searchParams.get("domain") || "");
  const src = domain ? getSources().find((s) => normalizeDomain(s.handle) === domain) : null;
  const verified = !!src;
  const left = "cited by AI";
  const right = verified ? "✓ verified by Merit" : "unverified";
  const rc = verified ? "#16A34A" : "#9CA3AF";
  const lw = 74, rw = verified ? 132 : 74, h = 20, W = lw + rw;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" role="img" aria-label="${esc(left)}: ${esc(right)}">
  <rect width="${W}" height="${h}" rx="3" fill="#0A0A0A"/>
  <rect x="${lw}" width="${rw}" height="${h}" fill="${rc}"/>
  <rect width="${W}" height="${h}" rx="3" fill="none"/>
  <g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lw / 2}" y="14" text-anchor="middle">${esc(left)}</text>
    <text x="${lw + rw / 2}" y="14" text-anchor="middle" font-weight="bold">${esc(right)}</text>
  </g>
</svg>`;
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=120",
      "access-control-allow-origin": "*",
    },
  });
}

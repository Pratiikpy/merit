/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this app dir (multiple lockfiles exist higher up).
  turbopack: { root: import.meta.dirname },
  // @circle-fin/x402-batching's server build pulls a module Turbopack can't resolve at bundle time on
  // Vercel; keep it external (required from node_modules at runtime, never bundled into the server
  // chunks). It's only invoked for real STUB=0 settlement, so the STUB demo never touches it.
  serverExternalPackages: ["@circle-fin/x402-batching", "@circle-fin/developer-controlled-wallets"],
  // Serve the hand-authored Merit frontend (public/index.html) at "/".
  // beforeFiles runs before app routes, so the static file wins.
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/index.html" },
        { source: "/brandkit", destination: "/brandkit.html" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  // Defense-in-depth HTTP headers. The CSP allows inline + Google Fonts (the
  // hand-authored frontend needs both) but locks down connect/frame/object/base —
  // so a hypothetical XSS can't exfiltrate to another origin, frame the page, or
  // hijack the base URI. esc() remains the primary XSS barrier; this backstops it.
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // HSTS — the deploy targets (Render/Railway/Fly) terminate TLS; force HTTPS.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;

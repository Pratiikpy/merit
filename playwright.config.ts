import { defineConfig, devices } from "@playwright/test";

/**
 * Merit end-to-end harness.
 *
 * Base URL: E2E_BASE_URL (default the local dev server on 3011 — 3000/3001 are taken by
 * another app on this machine and silently intercept). Point it at https://onmerit.xyz to
 * run the same suite against production.
 *
 * Stateful by default: retries 0 and workers 1, because money flows share nonces and the
 * shared prod mirror, and a retry that turns a real failure green is worse than no suite.
 * Read-only sweeps may opt into parallelism per-project.
 */
const baseURL = process.env.E2E_BASE_URL || "http://localhost:3011";

export default defineConfig({
  testDir: "./e2e/tests",
  outputDir: "./test-results",
  // A whole money flow can legitimately take ~10 min (testnet confirmation + LLM judge).
  timeout: 600_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  // Never let a stray .only silently shrink a CI run.
  forbidOnly: !!process.env.CI,
  reporter: [
    ["list"],
    ["json", { outputFile: "docs/qa/playwright-report.json" }],
    ["html", { outputFolder: "docs/qa/playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    video: "on",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ignoreHTTPSErrors: false,
  },
  projects: [
    // Clipboard permissions are Chromium-only — WebKit rejects the context with
    // "Unknown permission: clipboard-write" — so they are granted per-project, never globally.
    {
      name: "desktop-1280",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        permissions: ["clipboard-read", "clipboard-write"],
      },
    },
    {
      name: "desktop-1440",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        permissions: ["clipboard-read", "clipboard-write"],
      },
    },
    // iPhone 13 is a WebKit device descriptor — this is also the suite's Safari-engine coverage.
    { name: "mobile-390", use: { ...devices["iPhone 13"] } },
    { name: "mobile-375", use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 }, isMobile: false } },
    // The responsive floor. Anything that clips here clips on a real small phone.
    { name: "mobile-360", use: { ...devices["Desktop Chrome"], viewport: { width: 360, height: 640 }, isMobile: false } },
  ],
});

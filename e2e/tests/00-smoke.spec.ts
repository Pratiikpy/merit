import { test, expect, type ConsoleMessage, type Request } from "@playwright/test";

/**
 * Harness smoke: proves the e2e stack itself works end to end before anything is built on it.
 *
 * It is deliberately real — it drives the live hero verifier and asserts the money-gate
 * outcome, not just that a page rendered. A 200 is not a pass.
 */

/** Attach console/pageerror/requestfailed capture at the start of a test, the way every real row must. */
function captureDiagnostics(page: import("@playwright/test").Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e: Error) => pageErrors.push(e.message));
  page.on("requestfailed", (r: Request) => {
    // Ignore aborts we cause ourselves by navigating away.
    const f = r.failure()?.errorText || "";
    if (!/ERR_ABORTED/.test(f)) failedRequests.push(`${r.url()} :: ${f}`);
  });
  return { consoleErrors, pageErrors, failedRequests };
}

test.describe("harness smoke", () => {
  test("landing page renders, is clean, and does not scroll horizontally", async ({ page }) => {
    const diag = captureDiagnostics(page);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // The responsive floor matters more than any single breakpoint: horizontal scroll is a defect.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "page must not scroll horizontally").toBeLessThanOrEqual(0);

    expect(diag.pageErrors, "no uncaught page errors").toEqual([]);
    expect(diag.consoleErrors, "no console errors").toEqual([]);
    expect(diag.failedRequests, "no failed requests").toEqual([]);
  });

  test("the signer endpoint publishes a recoverable scheme", async ({ request }) => {
    const res = await request.get("/api/verify/signer");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.schema).toBe("merit.signer/v1");
    expect(body.signer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(body.bindingSpec?.version).toBe(1);
  });

  /**
   * THE HERO MOMENT. A fabricated *figure* is caught by the deterministic numeric gate — no model
   * involved, anyone can recompute it — so this holds even when the LLM judge and the NLI service
   * are unavailable. It is the single most important assertion in the suite.
   */
  test("hero: a fabricated figure is REFUSED, pays $0, and is signed", async ({ request }) => {
    const res = await request.post("/api/verify", {
      data: {
        claim: "Stablecoin transaction volume reached $40 trillion in 2025.",
        source: "Stablecoin transaction volume reached about $15.6 trillion in 2025.",
      },
      timeout: 120_000,
    });
    expect(res.status(), "the deterministic gate must not need any model").toBe(200);
    const v = await res.json();
    expect(v.verdict).toBe("REFUSED");
    expect(v.gates?.numeric?.ran, "the numeric gate must have run").toBe(true);
    expect(v.gates?.numeric?.pass).toBe(false);
    expect(v.signer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(v.signature).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  /**
   * The model-backed path. It needs the NLI service or the adversarial judge, so it 503s whenever
   * either is down. That 503 is the product behaving honestly — it refuses to guess — so this test
   * asserts the contract either way and fails loudly only on a wrong verdict, never on the outage.
   */
  test("judge path: decides a non-numeric claim, or 503s honestly when no model is available", async ({ request }) => {
    const payee = "0x415Fb8814084bDBC7B6964620Ba5Be5939aD2333";
    const res = await request.post("/api/verify", {
      data: {
        claim: "TollBit works with roughly 7,000 publisher sites.",
        source: "TollBit has onboarded roughly 7,000 publisher sites and raised 31 million dollars in funding.",
        amount: 0.002,
        payee,
        nonce: `smoke-${Date.now()}`,
      },
      timeout: 120_000,
    });

    if (res.status() === 503) {
      const body = await res.json();
      // Honest degradation: it must say it cannot decide, and must not invent a verdict.
      expect(body.numericOnly, "a 503 must be the documented model-unavailable shape").toBe(true);
      expect(body.verdict).toBeUndefined();
      test.info().annotations.push({
        type: "known-outage",
        description: "NLI service and/or LLM judge unavailable — model-backed verification is degraded on this deployment.",
      });
      return;
    }

    expect(res.status()).toBe(200);
    const v = await res.json();
    expect(v.verdict).toBe("SUPPORTED");
    expect(v.signature).toMatch(/^0x[0-9a-fA-F]+$/);
    // A receipt must never be able to authorize a different payment.
    expect(v.binding?.payee).toBe(payee);
    expect(v.binding?.amount).toBe(0.002);
    expect(v.binding?.bindingHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

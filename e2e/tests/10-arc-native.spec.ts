import { test, expect, type ConsoleMessage, type Request } from "@playwright/test";

/**
 * The Arc-native settlement layer, driven the way a reader actually meets it: the "Checked against Arc"
 * page in a real browser at every viewport the suite runs, plus the two public endpoints behind it.
 *
 * These assertions are about the SUBSTANCE, not the render. A page that loads while the reconciliation
 * silently fails is a failure here, and a memo endpoint that returns 200 with an unverifiable memo is a
 * failure here.
 */

function captureDiagnostics(page: import("@playwright/test").Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e: Error) => pageErrors.push(e.message));
  page.on("requestfailed", (r: Request) => {
    const f = r.failure()?.errorText || "";
    if (!/ERR_ABORTED/.test(f)) failedRequests.push(`${r.url()} :: ${f}`);
  });
  return { consoleErrors, pageErrors, failedRequests };
}

test.describe("checked against Arc", () => {
  test("the page renders its real reconciliation, cleanly and without horizontal scroll", async ({ page }) => {
    const diag = captureDiagnostics(page);
    await page.goto("/reconcile.html", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: /checked against arc/i })).toBeVisible();

    // The stats only lose their busy state once /api/reconcile has answered — so this waits for the real
    // chain read, not for the skeleton.
    const stats = page.locator("#stats");
    await expect(stats).not.toHaveAttribute("aria-busy", "true", { timeout: 45_000 });
    await expect(stats).toContainText(/settlements re-read from arc/i);
    await expect(stats).toContainText(/contradicted by the chain/i);

    // The outflow scan must resolve to a real statement, never sit on a shimmer.
    await expect(page.locator("#outflow")).toContainText(/outbound USDC transfers|outflow scan|not configured/i, { timeout: 45_000 });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "page must not scroll horizontally").toBeLessThanOrEqual(0);

    expect(diag.pageErrors, "no uncaught page errors").toEqual([]);
    expect(diag.consoleErrors, "no console errors").toEqual([]);
    expect(diag.failedRequests, "no failed requests").toEqual([]);
  });

  test("a nonsense memo query is refused in the UI rather than sent to Arc", async ({ page }) => {
    await page.goto("/reconcile.html", { waitUntil: "domcontentloaded" });
    await page.locator("#memoq").fill("not-a-hash");
    await page.locator("#memogo").click();
    await expect(page.locator("#memoout")).toContainText(/0x-prefixed 32-byte value/i);
  });

  test("the reconciliation endpoint answers with both directions and states its window", async ({ request }) => {
    const res = await request.get("/api/reconcile?limit=10&blocks=10000");
    expect(res.ok()).toBeTruthy();
    const b = await res.json();
    expect(b.schema).toBe("merit.reconcile/v1");
    expect(b.chain?.chainId).toBe(5042002);
    // Arc's two USDC emitters are the whole basis of the cross-check; both must be named.
    expect(b.chain?.usdc?.toLowerCase()).toBe("0x3600000000000000000000000000000000000000");
    expect(b.chain?.systemTransferEmitter?.toLowerCase()).toBe("0xfffffffffffffffffffffffffffffffffffffffe");

    // Direction 1: nothing we published may be contradicted by the chain.
    expect(b.ledgerToChain, "ledger→chain must be reported").toBeTruthy();
    expect(b.ledgerToChain.failed, `a published settlement disagrees with Arc: ${JSON.stringify(b.ledgerToChain.rows?.filter((r: { status: string }) => r.status === "mismatch" || r.status === "reverted"))}`).toBe(0);
    for (const row of b.ledgerToChain.rows || []) {
      expect(Array.isArray(row.ids) && row.ids.length > 0, "every reconciliation names the rows it covers").toBe(true);
      if (row.status === "match") expect(Math.abs(row.onchainUsdc - row.claimedUsdc)).toBeLessThanOrEqual(1e-6);
    }

    // Direction 2: a bounded scan must always disclose its bounds, or say why it could not run.
    if (b.chainToLedger) {
      expect(b.chainToLedger.window?.blocks, "the scan must state the window it covered").toBeGreaterThan(0);
      expect(typeof b.chainToLedger.unexplained).toBe("number");
    } else {
      expect(b.outflowError, "a missing scan must say why").toBeTruthy();
    }
  });

  test("the memo endpoint refuses a malformed lookup instead of guessing", async ({ request }) => {
    const bad = await request.get("/api/memo?tx=0xdeadbeef");
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toMatch(/32-byte hash/i);

    const none = await request.get("/api/memo");
    expect(none.status()).toBe(400);
    const body = await none.json();
    expect(body.contract?.toLowerCase()).toBe("0x5294e9927c3306dcbadb03fe70b92e01ccede505");
  });

  test("a memoId lookup reports its search window, so 'not found' is never mistaken for 'does not exist'", async ({ request }) => {
    const res = await request.get(`/api/memo?id=0x${"0".repeat(63)}1&blocks=10000`);
    // Either the chain answered, or the RPC did not — both are acceptable; a silent empty result is not.
    if (res.ok()) {
      const b = await res.json();
      expect(b.schema).toBe("merit.memo.lookup/v1");
      expect(b.window?.blocks).toBeGreaterThan(0);
      expect(b.note).toMatch(/bounded recent-history scan/i);
    } else {
      expect(res.status()).toBe(502);
    }
  });

  test("the gasless funding endpoint is gated and self-describing", async ({ request }) => {
    // No key: the route must refuse rather than expose a relayer to anonymous callers.
    const anon = await request.get("/api/relay");
    expect([401, 403]).toContain(anon.status());
    expect((await anon.json()).error).toMatch(/API key|session key/i);
  });
});

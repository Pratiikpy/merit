/**
 * One-command creator onboarding — the fork-and-run distribution wedge.
 *
 *   npm run onboard-feed <rss-feed-url> [baseUrl]
 *
 * Turns any RSS/Atom feed into a citable + payable Merit creator in one step: a receive-only wallet (or the
 * owner's own, if the feed carries a `merit-verify:0x…` marker) and an ERC-8004 identity. Needs a running
 * Merit server (npm run dev) — pass a baseUrl or set MERIT_BASE to target a deployed instance.
 */
const feedUrl = process.argv[2];
const base = process.argv[3] || process.env.MERIT_BASE || "http://localhost:3000";

if (!feedUrl) {
  console.error("usage: npm run onboard-feed <rss-feed-url> [baseUrl]");
  console.error("   e.g. npm run onboard-feed https://hnrss.org/frontpage");
  process.exit(1);
}

try {
  const res = await fetch(`${base}/api/creators/from-feed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feedUrl }),
  });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`✗ ${r.error || `onboarding failed (${res.status})`}`);
    process.exit(1);
  }
  console.log(`\n✓ onboarded "${r.name}" — ${r.entries} recent entries are now citable.`);
  console.log(`  payout wallet : ${r.wallet}${r.ownerVerified ? "  [owner-verified ✓]" : "  (Merit-generated, receive-only)"}`);
  console.log(`  ERC-8004 id   : #${r.agentId ?? "—"}`);
  console.log(`  explorer      : ${r.explorerUrl ?? "—"}`);
  console.log(`\n  It can now be cited + paid in any run. Every verified citation settles USDC to that wallet.`);
  if (!r.ownerVerified) {
    console.log(`  To claim payouts to YOUR wallet, add this line anywhere in your feed, then re-run:`);
    console.log(`      merit-verify:0xYourWalletAddress\n`);
  } else {
    console.log("");
  }
} catch (e) {
  console.error(`✗ could not reach Merit at ${base} — is it running? (${e instanceof Error ? e.message : e})`);
  process.exit(1);
}

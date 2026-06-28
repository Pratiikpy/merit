/**
 * Proof-of-Citation Passport — turn the verification moat into the distribution moat.
 *
 * A creator proves control of their DOMAIN (not just an RSS feed) by publishing `/.well-known/merit.json`
 * with their payout wallet. Merit fetches it, binds the domain → wallet, and the creator becomes an
 * OWNER-VERIFIED creator — the strongest claim a publisher can make, and it works for ANY site/CMS, not just
 * feeds. Then every site can embed a "Cited by AI — Verified by Merit" badge that is independently falsifiable
 * (it resolves against Merit's deterministic verifier + on-chain settlement), so a self-report agent's badge —
 * backed by one LLM grading itself — is unforgeable noise by comparison. Verification becomes distribution.
 */

const MAX_BYTES = 64 * 1024;

export interface DomainPassport {
  domain: string;
  wallet: `0x${string}`;
  name: string;
  content: string; // optional citable text the owner declares; "" if not provided
  verifiedAt: string;
}

/** Strip protocol/path → bare host. Lowercased. Rejects obvious non-hosts. */
export function normalizeDomain(input: string): string {
  let d = String(input || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  return d;
}

/** Fetch https://<domain>/.well-known/merit.json and return the proven payout wallet. Throws a short,
 *  user-facing message on any failure (fails closed). */
export async function verifyDomainClaim(input: string): Promise<DomainPassport> {
  const domain = normalizeDomain(input);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error("not a valid domain");

  const url = `https://${domain}/.well-known/merit.json`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "merit-passport/1" },
    signal: AbortSignal.timeout(10_000),
    redirect: "follow",
  }).catch(() => {
    throw new Error(`could not reach https://${domain}/.well-known/merit.json`);
  });
  if (!res.ok) throw new Error(`/.well-known/merit.json returned ${res.status} — publish it at your domain root`);

  const buf = await res.arrayBuffer();
  let json: { wallet?: string; payTo?: string; name?: string; content?: string };
  try {
    json = JSON.parse(new TextDecoder().decode(buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf));
  } catch {
    throw new Error("/.well-known/merit.json is not valid JSON");
  }
  const w = String(json.wallet || json.payTo || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(w) || /^0x0+$/i.test(w)) {
    throw new Error('/.well-known/merit.json must contain {"wallet":"0x…"} (a non-zero payout address)');
  }
  return {
    domain,
    wallet: w as `0x${string}`,
    name: String(json.name || domain).slice(0, 80),
    content: String(json.content || "").slice(0, 2000),
    verifiedAt: new Date().toISOString(),
  };
}

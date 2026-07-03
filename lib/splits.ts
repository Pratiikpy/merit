/**
 * Weighted / recursive creator splits (Wave D #12) — the payout TAIL of the verify gate. When a verified
 * citation settles to a multi-author source, its earning is split across the contributors by weight; a
 * contributor can itself be a collective, so splits resolve RECURSIVELY down the lineage to leaf recipients.
 * Crucially this is strictly DOWNSTREAM of verification — only the amount a passing citation released is ever
 * split, so this is a payout distributor, not a generic money splitter (a refused citation splits nothing).
 * Pure + deterministic; the caller settles/accrues each leaf share via the normal rails.
 */
export interface SplitRecipient {
  name: string;
  weight: number; // relative weight (normalized against its siblings)
  domain?: string; // for a custodial claim (the leaf proves this to withdraw)
  wallet?: string; // a receive-only payout wallet, if the recipient has one
}
export interface ResolvedShare {
  name: string;
  domain?: string;
  wallet?: string;
  weight: number; // effective fraction (0..1) of the total
  amount: number; // its cut of the settled amount
}

const MAX_DEPTH = 5;

/** Split `amount` across `splits` by weight, recursing into any recipient that itself resolves to sub-splits
 *  (lineage). Cycles + over-deep chains collapse to the recipient as a leaf. Leaf shares always sum to `amount`
 *  (within rounding); zero/negative weights are dropped. */
export function computeSplits(
  splits: SplitRecipient[] | undefined,
  amount: number,
  opts?: { resolve?: (name: string) => SplitRecipient[] | null | undefined },
): ResolvedShare[] {
  const out: ResolvedShare[] = [];
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

  const walk = (list: SplitRecipient[], portion: number, seen: Set<string>, depth: number) => {
    const valid = (list || []).filter((r) => r && r.name && r.weight > 0);
    const total = valid.reduce((s, r) => s + r.weight, 0);
    if (total <= 0) return;
    for (const r of valid) {
      const frac = r.weight / total;
      const sub = depth < MAX_DEPTH && !seen.has(r.name.toLowerCase()) ? opts?.resolve?.(r.name) : null;
      if (sub && sub.length) {
        walk(sub, portion * frac, new Set(seen).add(r.name.toLowerCase()), depth + 1);
      } else {
        out.push({ name: r.name, domain: r.domain, wallet: r.wallet, weight: round6(portion * frac), amount: round6(amount * portion * frac) });
      }
    }
  };

  walk(splits || [], 1, new Set(), 0);
  // Merge duplicate leaves (the same recipient reachable via two branches) so the receipt lists each once.
  const merged = new Map<string, ResolvedShare>();
  for (const s of out) {
    const key = (s.wallet || s.domain || s.name).toLowerCase();
    const e = merged.get(key);
    if (e) {
      e.amount = round6(e.amount + s.amount);
      e.weight = round6(e.weight + s.weight);
    } else {
      merged.set(key, { ...s });
    }
  }
  return [...merged.values()].sort((a, b) => b.amount - a.amount);
}

/** True when a source distributes its earnings across contributors rather than taking them whole. */
export function hasSplits(splits?: SplitRecipient[]): boolean {
  return Array.isArray(splits) && splits.filter((r) => r && r.name && r.weight > 0).length > 0;
}

// King of the Hill: the hold ranking. Every group that holds the hill banks
// the seconds it held it, across every separate hold of the same stand; the
// realm hears the standings every HILL_NOTICE_SECONDS while the hill stands
// and once more when it falls, and the group (or groups, on a tie) that held
// it longest earns one point toward the Weekly Vault's PvP row (hill.ts pays
// it through the host-injected credit, so this barrel never imports the vault
// module: an import cycle through entity.ts).
//
// Pure: no SimContext, no rng, no clock. The records live on the hill
// (ActiveHill.holds), the sim updates them in its once-a-second pass, and the
// ordering here is a plain function of them, so every host ranks the same.

/** One group's hold over one stand. */
export interface HillHoldRecord {
  /** The group key (hill_rules.ts hillGroupKey). */
  key: string;
  /** Seconds this group has held the hill over the whole stand, summed over
   *  every separate hold. */
  seconds: number;
  /** The name the realm knows the group by: its party leader's, or the lone
   *  player's. Refreshed on each pass a member stands inside. */
  name: string;
  /** A party (the "{name}'s group" line) or a lone player (the bare name). */
  party: boolean;
  /** Every player who stood inside while this group held the hill, in the
   *  order they first did: the Weekly Vault point's payees. */
  holders: Set<number>;
}

/** How many places the realm announcements list. */
export const HILL_RANKING_SHOWN = 3;

/** The groups that held the hill, longest first. A tie keeps the order the
 *  groups first held it (the records map's insertion order; Array.sort is
 *  stable), so the ranking is the same on every host. */
export function hillRanking(records: Iterable<HillHoldRecord>): HillHoldRecord[] {
  return [...records].filter((r) => r.seconds > 0).sort((a, b) => b.seconds - a.seconds);
}

/** Every group tied for the longest hold, or none when nobody held the hill:
 *  a tie at the top shares the award rather than breaking it on an order. */
export function hillLongestHolds(records: Iterable<HillHoldRecord>): HillHoldRecord[] {
  const ranked = hillRanking(records);
  if (ranked.length === 0) return [];
  const best = ranked[0].seconds;
  return ranked.filter((r) => r.seconds === best);
}

/** The players the longest hold pays: every holder of every group tied at the
 *  top, each once (a player who held for two tied groups earns one point). */
export function hillVaultPayees(records: Iterable<HillHoldRecord>): number[] {
  const payees = new Set<number>();
  for (const record of hillLongestHolds(records)) {
    for (const pid of record.holders) payees.add(pid);
  }
  return [...payees];
}

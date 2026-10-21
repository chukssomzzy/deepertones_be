import { sha256Hex } from '../../lib/crypto'
import { stableJson } from '../../lib/stable-json'
import { REFERENCE, REFERENCE_VERSION, type ReferenceEntry } from './catalog.reference'
import { seedRuleCode } from './catalog.workbook.seed'

// The rules version names a SET of approved ingredient rules, not a moment: the same set always has the same version, so restoring a rule to
// what it was gives back the version analyses were already stamped with, and nothing is analysed again for no reason.

/**
 * The first 16 hex digits of the sha256 of the entries as the matcher reads them (name, aliases, kind, statement, source), in code order. The
 * aliases of a rule are a set (the matcher looks a name up among them), so their order is not part of the version.
 */
const fingerprint = async (entries: ReferenceEntry[]): Promise<string> =>
  (await sha256Hex(stableJson(entries.map((entry) => ({ ...entry, aliases: [...entry.aliases].sort() }))))).slice(0, 16)

/** The seed rules in code order, as the migration stored them: the one set that has a version not made by hashing. */
const seedFingerprint = (): Promise<string> =>
  fingerprint([...REFERENCE].sort((a, b) => (seedRuleCode(a) < seedRuleCode(b) ? -1 : seedRuleCode(a) > seedRuleCode(b) ? 1 : 0)))

/**
 * The rules version for `next`, the approved rules an upload leaves in force (in code order), given the version and rules in force now.
 * An unchanged set keeps the version it has (a Products-only upload moves nothing). The seed set is always `seed-2026-10`, so going back to
 * it is not a new version. Any other set is `rules-<16 hex>` of its fingerprint.
 */
export const nextRulesVersion = async (current: { version: string; entries: ReferenceEntry[] }, next: ReferenceEntry[]): Promise<string> => {
  const [now, after] = await Promise.all([fingerprint(current.entries), fingerprint(next)])
  if (now === after) return current.version
  return after === (await seedFingerprint()) ? REFERENCE_VERSION : `rules-${after}`
}

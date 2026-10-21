import type { ReferenceEntry } from './catalog.reference'

// How the migration that created `ingredient_rules` named the rules it seeded from REFERENCE. The seed script writes the codes, and the in-memory
// repository the unit tests use gives its starting rules the same ones, so a unit test and the migrated database name a rule alike.

const CODE_LIMIT = 40

const slug = (text: string): string => text.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** `ING-<NAME>-<KIND>` in capitals, a run of anything but a letter or digit as one hyphen, cut to 40 characters from the end. */
export const seedRuleCode = (entry: Pick<ReferenceEntry, 'name' | 'kind'>): string =>
  `ING-${slug(entry.name)}-${slug(entry.kind)}`.slice(0, CODE_LIMIT).replace(/-+$/, '')

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { REFERENCE, REFERENCE_VERSION } from '../../src/modules/catalog/catalog.reference'
import { flagFacts } from '../../src/modules/catalog/catalog.rules'
import { D1CatalogWorkbookRepository } from '../../src/modules/catalog/catalog.workbook.repository'
import { FakeCatalogWorkbookRepository } from '../../src/modules/catalog/catalog.workbook.repository.fake'

// The day the rules move into the database, an analysis must be given the same facts, in the same order, as it was when REFERENCE held them: the
// analyst is shown them in that order, and the eval's expected flags are written in it. The database does not list the rules in REFERENCE order
// (it lists them by code), so the facts of one ingredient (retinol is both a sun sensitiser and a pregnancy caution) must come out in the same
// order whichever rule is read first. This file reads the migrated, seeded rules and never writes to them.

const repository = new D1CatalogWorkbookRepository(createDb(env.DB))
const live = async () => (await repository.liveRules()).entries

/** Every name and alias in REFERENCE, once. */
const LABELS = [...new Set(REFERENCE.flatMap((entry) => [entry.name, ...entry.aliases]))]

describe('the seeded live rules, as the analysis reads them', () => {
  it('are the REFERENCE rules, all of them, under seed-2026-10', async () => {
    const rules = await repository.liveRules()

    expect(rules.version).toBe(REFERENCE_VERSION)
    expect(rules.entries).toHaveLength(REFERENCE.length)
    expect([...rules.entries].sort((a, b) => (a.name + a.kind < b.name + b.kind ? -1 : 1))).toEqual([...REFERENCE].sort((a, b) => (a.name + a.kind < b.name + b.kind ? -1 : 1)))
  })

  it('are listed in the same order by the in-memory repository the unit tests use, so a unit test sees what the database serves', async () => {
    expect(await new FakeCatalogWorkbookRepository().liveRules()).toEqual(await repository.liveRules())
  })

  it('flag every name and alias exactly as REFERENCE does, fact for fact and in the same order', async () => {
    const entries = await live()

    expect(LABELS.length).toBeGreaterThan(REFERENCE.length)
    for (const label of LABELS) expect(flagFacts([label], entries), label).toEqual(flagFacts([label], REFERENCE))
  })

  it('flag every name and alias written in capitals and with a trailing mark, as labels are', async () => {
    const entries = await live()

    for (const label of LABELS) {
      const written = `${label.toUpperCase()}*`
      expect(flagFacts([written], entries), written).toEqual(flagFacts([written], REFERENCE))
    }
  })

  it('flag a label with another in brackets, either way round, exactly as REFERENCE does: the facts of a retinoid keep their order', async () => {
    const entries = await live()
    const forms = LABELS.flatMap((outside) => LABELS.map((inside) => `${outside} (${inside})`))

    expect(forms.length).toBe(LABELS.length ** 2)
    for (const form of forms) expect(flagFacts([form], entries), form).toEqual(flagFacts([form], REFERENCE))
  })

  it('flag the retinoids, which have two concerns each, in the order REFERENCE gives them', async () => {
    const entries = await live()

    for (const name of ['retinol', 'retinal', 'retinaldehyde', 'hydroquinone', 'quinol']) {
      expect(flagFacts([name], entries).map((fact) => fact.kind), name).toEqual(flagFacts([name], REFERENCE).map((fact) => fact.kind))
    }
  })

  it('flag one list that holds every name and alias, in the order REFERENCE does', async () => {
    expect(flagFacts(LABELS, await live())).toEqual(flagFacts(LABELS, REFERENCE))
  })
})

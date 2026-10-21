import { describe, expect, it } from 'vitest'
import type { CatalogWorkbookRepository } from './catalog.workbook.repository'
import type { ConcernKind } from './catalog.vocabulary'
import type { ShownConcern } from '../face-scans/face-scans.tables'

// One ingredient rule as the workbook's Ingredients tab holds it and `ingredient_rules` stores it. The dates are the workbook's own
// `YYYY-MM-DD` text (a date, not an instant), because `approved_on` is a calendar day somebody signed on.
export type RuleRow = {
  code: string
  name: string
  aliases: string[]
  kind: ConcernKind
  strengthLimit: string | null
  statement: string
  sourceUrl: string | null
  helps: ShownConcern[]
  status: 'draft' | 'approved' | 'retired'
  approvedBy: string | null
  approvedOn: string | null
  auditedBy: string | null
  auditedOn: string | null
}

/** The day every rule here was signed off; a calendar day, as the workbook writes it. */
const APPROVED_ON = '2030-06-15'

// Each call yields a value no other test (or earlier run against a shared D1) uses.
const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
const fresh = (label: string) => `${label}-${runSalt}-${counter++}`

/** An approved rule for an ingredient nobody else names, with every optional cell filled in; override what a test is about. */
export const ruleRow = (over: Partial<RuleRow> = {}): RuleRow => {
  const slug = fresh('zzyzx')
  return {
    code: `ING-${slug.toUpperCase()}-IRRITATION`,
    name: slug,
    aliases: [`${slug} oil`],
    kind: 'irritation',
    strengthLimit: '2% in leave-on products',
    statement: 'Commonly reported to sting skin with a weakened barrier.',
    sourceUrl: null,
    helps: ['hd_redness'],
    status: 'approved',
    approvedBy: 'Dr A. Reviewer',
    approvedOn: APPROVED_ON,
    auditedBy: null,
    auditedOn: null,
    ...over,
  }
}

/**
 * What a test needs besides the repository: a way to put the catalog in a state. The only write path that exists in production is the
 * workbook import (a later change), so each tier supplies its own: the fake's own method, and rows written straight into D1.
 * `publish` makes `rules` the whole rules set and records a new catalog version carrying `rulesVersion`.
 */
export type RulesHarness = {
  repo: CatalogWorkbookRepository
  publish: (rulesVersion: string, rules: RuleRow[]) => Promise<void>
}

/** Behaviour every CatalogWorkbookRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const catalogWorkbookRepositoryContract = (name: string, make: () => RulesHarness | Promise<RulesHarness>) => {
  describe(`CatalogWorkbookRepository contract: ${name}`, () => {
    describe('liveRules', () => {
      it('returns the rules version of the latest catalog version, with the approved rules in the shape the matcher reads', async () => {
        const { repo, publish } = await make()
        const rule = ruleRow({
          name: 'zzyzx extractum',
          aliases: ['zzyzx oil', 'zzyzx'],
          kind: 'pregnancy-caution',
          statement: 'Commonly advised against while pregnant.',
          sourceUrl: 'https://example.com/zzyzx',
        })
        await publish('rules-contract-1', [rule])

        const live = await repo.liveRules()

        expect(live).toEqual({
          version: 'rules-contract-1',
          entries: [
            {
              name: 'zzyzx extractum',
              aliases: ['zzyzx oil', 'zzyzx'],
              kind: 'pregnancy-caution',
              rule: 'Commonly advised against while pregnant.',
              source: 'https://example.com/zzyzx',
            },
          ],
        })
      })

      it('gives a rule with no source a source of null, and a rule with no aliases an empty list', async () => {
        const { repo, publish } = await make()
        await publish('rules-contract-2', [ruleRow({ name: 'zzyzx plain', aliases: [], sourceUrl: null })])

        const { entries } = await repo.liveRules()

        expect(entries).toEqual([expect.objectContaining({ name: 'zzyzx plain', aliases: [], source: null })])
      })

      it('leaves out every rule that is not approved: a draft applies to nothing, and neither does a retired one', async () => {
        const { repo, publish } = await make()
        const approved = ruleRow({ name: 'zzyzx approved' })
        await publish('rules-contract-3', [
          approved,
          ruleRow({ name: 'zzyzx draft', status: 'draft', approvedBy: null, approvedOn: null }),
          ruleRow({ name: 'zzyzx retired', status: 'retired' }),
        ])

        const { entries } = await repo.liveRules()

        expect(entries.map((e) => e.name)).toEqual(['zzyzx approved'])
      })

      it('returns no entries, and still the version, when no rule is approved', async () => {
        const { repo, publish } = await make()
        await publish('rules-contract-4', [ruleRow({ status: 'draft', approvedBy: null, approvedOn: null })])

        expect(await repo.liveRules()).toEqual({ version: 'rules-contract-4', entries: [] })
      })

      it('lists the rules in the order of their codes, so the same set always reads the same', async () => {
        const { repo, publish } = await make()
        const rules = [ruleRow({ code: 'ING-ZZ-C', name: 'zzyzx c' }), ruleRow({ code: 'ING-ZZ-A', name: 'zzyzx a' }), ruleRow({ code: 'ING-ZZ-B', name: 'zzyzx b' })]
        await publish('rules-contract-5', rules)

        const { entries } = await repo.liveRules()

        expect(entries.map((e) => e.name)).toEqual(['zzyzx a', 'zzyzx b', 'zzyzx c'])
      })

      it('reports the newest version and its rules each time it is asked, never an earlier one it has already read', async () => {
        const { repo, publish } = await make()
        await publish('rules-contract-6a', [ruleRow({ name: 'zzyzx first' })])
        expect((await repo.liveRules()).version).toBe('rules-contract-6a')

        await publish('rules-contract-6b', [ruleRow({ name: 'zzyzx second' })])

        const live = await repo.liveRules()
        expect(live.version).toBe('rules-contract-6b')
        expect(live.entries.map((e) => e.name)).toEqual(['zzyzx second'])
      })

      it('reads the same version again when nothing was published in between', async () => {
        const { repo, publish } = await make()
        await publish('rules-contract-7', [ruleRow({ name: 'zzyzx steady' })])

        expect(await repo.liveRules()).toEqual(await repo.liveRules())
      })
    })
  })
}

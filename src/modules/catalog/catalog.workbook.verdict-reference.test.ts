import { describe, expect, it } from 'vitest'
import type { IngredientRule, TaperRow } from './catalog.workbook.schema'
import { approvedTapersOf, verdictRulesOf } from './catalog.workbook.service'

// The two pure mappings behind `CatalogWorkbookService.verdictReference`, exported so the verdict eval builds its reference through the same lines as the live
// service (as it does for `referenceEntriesOf`). The service's own tests pin what it returns from its repository; these pin the mappings on their own, so a
// second caller can rely on them. Neither is told what "approved" means for a rule: the service passes the rules it approved, the eval passes its own set.

const BASE = new Date('2030-06-15T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const at = (offset: number): Date => new Date(BASE.getTime() + offset * DAY)

const rule = (over: Partial<IngredientRule> = {}): IngredientRule => ({
  code: 'ING-ONE',
  name: 'zzyzx extractum',
  aliases: [],
  kind: 'irritation',
  strengthLimit: null,
  statement: 'Commonly reported to sting.',
  sourceUrl: null,
  helps: [],
  group: null,
  clashesWith: [],
  status: 'approved',
  approvedBy: 'Dr A',
  reviewerRole: null,
  approvedOn: at(-3),
  auditedBy: null,
  auditedOn: null,
  ...over,
})

describe('verdictRulesOf', () => {
  it('maps a rule to what the matcher reads and the metadata only the floor and the fit judge use, and nothing else of the row', () => {
    const mapped = verdictRulesOf([
      rule({ code: 'ING-ZZ-ONE', name: 'zzyzx extractum', aliases: ['zzyzx oil'], kind: 'irritation', statement: 'Commonly reported to sting.', sourceUrl: 'https://example.com/zz', group: 'steroid', clashesWith: ['retinoid'], helps: ['hd_redness', 'hd_texture'] }),
    ])

    expect(mapped).toEqual([
      {
        name: 'zzyzx extractum',
        aliases: ['zzyzx oil'],
        kind: 'irritation',
        rule: 'Commonly reported to sting.',
        source: 'https://example.com/zz',
        group: 'steroid',
        clashesWith: ['retinoid'],
        helps: ['hd_redness', 'hd_texture'],
      },
    ])
  })

  it('gives a rule with no group, no clash and nothing it helps a null group and empty lists, and a rule with no source a null source', () => {
    const [mapped] = verdictRulesOf([rule()])

    expect(mapped).toMatchObject({ group: null, clashesWith: [], helps: [], source: null })
  })

  it('puts the rules in code order, whatever order they were given in', () => {
    const mapped = verdictRulesOf([rule({ code: 'ING-C', name: 'third' }), rule({ code: 'ING-A', name: 'first' }), rule({ code: 'ING-B', name: 'second' })])

    expect(mapped.map((r) => r.name)).toEqual(['first', 'second', 'third'])
  })

  it('does not change the rules it was given, and gives back lists of its own', () => {
    const given = [rule({ code: 'ING-B', name: 'b', aliases: ['bee'], clashesWith: ['retinoid'] }), rule({ code: 'ING-A', name: 'a' })]
    const before = structuredClone(given)

    const mapped = verdictRulesOf(given)
    mapped.find((r) => r.name === 'b')!.aliases.push('changed')

    expect(given).toEqual(before)
  })

  it('keeps every rule it is given, whatever its status: which rules count is the caller\'s choice', () => {
    const mapped = verdictRulesOf([rule({ code: 'ING-A', name: 'approved one' }), rule({ code: 'ING-B', name: 'draft one', status: 'draft', approvedBy: null, approvedOn: null })])

    expect(mapped.map((r) => r.name)).toEqual(['approved one', 'draft one'])
  })
})

const taper = (over: Partial<TaperRow> = {}): TaperRow => ({
  code: 'TPR-STEROID-1',
  kind: 'steroid',
  schedule: [{ fromWeek: 1, toWeek: 2, frequency: 'alternate-days' }, { fromWeek: 3, toWeek: 3, frequency: 'stop' }],
  whatToExpect: 'Skin may flare for a few days after each step down.',
  seeAProfessionalIf: 'The redness spreads.',
  status: 'approved',
  approvedBy: 'Dr A',
  approvedOn: at(-3),
  auditedBy: null,
  auditedOn: null,
  ...over,
})

describe('approvedTapersOf', () => {
  it('names the one approved template of each kind', () => {
    expect(approvedTapersOf([taper({ code: 'TPR-STEROID-1' }), taper({ code: 'TPR-LIGHTENING-1', kind: 'lightening-agent' })])).toEqual({ steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' })
  })

  it('leaves a kind that has no approved template out, rather than naming a null', () => {
    const tapers = approvedTapersOf([taper({ code: 'TPR-STEROID-1' })])

    expect(tapers).toEqual({ steroid: 'TPR-STEROID-1' })
    expect('lightening-agent' in tapers).toBe(false)
  })

  it('gives an empty answer when there are no templates', () => {
    expect(approvedTapersOf([])).toEqual({})
  })

  it('chooses the template approved most recently when a kind has more than one, in any order', () => {
    const rows = [taper({ code: 'TPR-STEROID-1', approvedOn: at(-30) }), taper({ code: 'TPR-STEROID-2', approvedOn: at(-1) }), taper({ code: 'TPR-STEROID-0', approvedOn: at(-60) })]

    expect(approvedTapersOf(rows)).toEqual({ steroid: 'TPR-STEROID-2' })
    expect(approvedTapersOf([...rows].reverse())).toEqual({ steroid: 'TPR-STEROID-2' })
  })

  it('chooses the lower code when two templates of a kind were approved on the same day, in any order', () => {
    const rows = [
      taper({ code: 'TPR-LIGHT-B', kind: 'lightening-agent', approvedOn: at(-5) }),
      taper({ code: 'TPR-LIGHT-A', kind: 'lightening-agent', approvedOn: at(-5) }),
      taper({ code: 'TPR-LIGHT-C', kind: 'lightening-agent', approvedOn: at(-5) }),
    ]

    expect(approvedTapersOf(rows)).toEqual({ 'lightening-agent': 'TPR-LIGHT-A' })
    expect(approvedTapersOf([...rows].reverse())).toEqual({ 'lightening-agent': 'TPR-LIGHT-A' })
  })

  it('prefers a template approved a day later over one with a lower code', () => {
    expect(approvedTapersOf([taper({ code: 'TPR-STEROID-1', approvedOn: at(-5) }), taper({ code: 'TPR-STEROID-9', approvedOn: at(-4) })])).toEqual({ steroid: 'TPR-STEROID-9' })
  })

  it('never chooses a retired or draft template, however recently it was approved or drafted', () => {
    const tapers = approvedTapersOf([
      taper({ code: 'TPR-STEROID-1', approvedOn: at(-30) }),
      taper({ code: 'TPR-STEROID-NEW-RETIRED', status: 'retired', approvedOn: at(-1) }),
      taper({ code: 'TPR-STEROID-NEW-DRAFT', status: 'draft', approvedBy: null, approvedOn: null }),
    ])

    expect(tapers).toEqual({ steroid: 'TPR-STEROID-1' })
  })

  it('names nothing for a kind whose only templates are drafts or retired', () => {
    const tapers = approvedTapersOf([taper({ code: 'TPR-STEROID-D', status: 'draft', approvedBy: null, approvedOn: null }), taper({ code: 'TPR-STEROID-R', status: 'retired' })])

    expect(tapers).toEqual({})
  })
})

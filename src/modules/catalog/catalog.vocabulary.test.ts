import { describe, expect, it } from 'vitest'
import { productAnalystAnalysePrompt } from '../../prompts/prompts.generated'
import * as vocabulary from './catalog.vocabulary'
import { ANALYSIS_VERSION, BUDGET_BANDS, CATEGORIES, CONCERN_KINDS, FREQUENCIES, FRESH_FOR_DAYS, ORIGINS, ROUTINE_STEPS, SEVERITIES, TRAITS } from './catalog.vocabulary'

describe('catalog vocabulary', () => {
  it('lists the product categories', () => {
    expect(CATEGORIES).toEqual(['skin', 'hair', 'body', 'makeup', 'other'])
  })

  it('lists the concern kinds', () => {
    expect(CONCERN_KINDS).toEqual([
      'irritation',
      'allergen',
      'pore-clogging',
      'sun-sensitivity',
      'hyperpigmentation-risk',
      'pregnancy-caution',
      'interaction',
      'restricted-substance',
      'banned-substance',
      'drying',
    ])
  })

  // The groups an ingredient rule may belong to, and the kinds of product a step-down template is for. A namespace import, so a missing export
  // is one failing test and not a file that cannot load.
  it('lists the ingredient groups a rule may have', () => {
    expect((vocabulary as unknown as Record<string, unknown>).INGREDIENT_GROUPS).toEqual(['mercury', 'steroid', 'lightening-agent', 'retinoid', 'exfoliating-acid', 'benzoyl-peroxide'])
  })

  it('lists the kinds a step-down template is for, which are the groups that are stopped with a plan and not at once', () => {
    const named = vocabulary as unknown as Record<string, readonly string[] | undefined>
    expect(named.TAPER_KINDS).toEqual(['steroid', 'lightening-agent'])
    for (const kind of named.TAPER_KINDS ?? []) expect(named.INGREDIENT_GROUPS, kind).toContain(kind)
  })

  it('lists the severities, mildest first', () => {
    expect(SEVERITIES).toEqual(['low', 'medium', 'high'])
  })

  it('lists the skin and goal traits', () => {
    expect(TRAITS).toEqual([
      'acne-prone',
      'dark-spots',
      'redness',
      'oily',
      'dry',
      'sensitive',
      'large-pores',
      'texture',
      'wrinkles',
      'fitzpatrick-1',
      'fitzpatrick-2',
      'fitzpatrick-3',
      'fitzpatrick-4',
      'fitzpatrick-5',
      'fitzpatrick-6',
      'pregnancy',
      'goal:clear-skin',
      'goal:even-tone',
      'goal:fade-dark-marks',
      'goal:brighter',
      'goal:glow',
      'goal:calm-repair',
    ])
  })

  // The recommendation catalog's own vocabularies (spec #115). The workbook contract accepts exactly these values, in these spellings.
  it('lists the routine steps, in the order a routine is done', () => {
    expect(ROUTINE_STEPS).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
  })

  it('lists how often a product is used', () => {
    expect(FREQUENCIES).toEqual(['am', 'pm', 'am-pm', 'alternate-days', 'weekly', 'as-needed'])
  })

  it('lists the budget bands, cheapest first', () => {
    expect(BUDGET_BANDS).toEqual(['low', 'mid', 'high'])
  })

  it('lists where a recommendation came from', () => {
    expect(ORIGINS).toEqual(['sourced', 'brand-submitted'])
  })

  it('starts the analysis at version 1 and keeps a formulation fresh for a year', () => {
    expect(ANALYSIS_VERSION).toBe(1)
    expect(FRESH_FOR_DAYS).toBe(365)
  })

  // Changing the analyse prompt fails this test. If the change altered what the prompt means, bump ANALYSIS_VERSION too
  // (stored analyses are refreshed and the rejection count restarts); if it is only a typo fix or rewording, update the hash alone.
  // The hash is the sha256 of src/prompts/product-analyst.analyse.md's body: front matter stripped, one trailing newline
  // trimmed, {{whyGuidance}} / {{whoGuidance}} left unfilled.
  it('pins the analyse prompt next to the analysis version', () => {
    expect(ANALYSIS_VERSION).toBe(1)
    expect(productAnalystAnalysePrompt.hash).toBe('feee45b3dd0d94471062a4ac7a6202da0cdb33888b52c2f1ba6ee1a5dbe27702')
  })

  it.each([
    ['CATEGORIES', CATEGORIES],
    ['CONCERN_KINDS', CONCERN_KINDS],
    ['SEVERITIES', SEVERITIES],
    ['TRAITS', TRAITS],
    ['ROUTINE_STEPS', ROUTINE_STEPS],
    ['FREQUENCIES', FREQUENCIES],
    ['BUDGET_BANDS', BUDGET_BANDS],
    ['ORIGINS', ORIGINS],
  ])('%s has no duplicates', (_name, list) => {
    expect(new Set(list).size).toBe(list.length)
  })
})

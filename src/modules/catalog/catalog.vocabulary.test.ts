import { describe, expect, it } from 'vitest'
import { ANALYSIS_VERSION, CATEGORIES, CONCERN_KINDS, FRESH_FOR_DAYS, SEVERITIES, TRAITS } from './catalog.vocabulary'

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
    ])
  })

  it('starts the analysis at version 1 and keeps a formulation fresh for a year', () => {
    expect(ANALYSIS_VERSION).toBe(1)
    expect(FRESH_FOR_DAYS).toBe(365)
  })

  it.each([
    ['CATEGORIES', CATEGORIES],
    ['CONCERN_KINDS', CONCERN_KINDS],
    ['SEVERITIES', SEVERITIES],
    ['TRAITS', TRAITS],
  ])('%s has no duplicates', (_name, list) => {
    expect(new Set(list).size).toBe(list.length)
  })
})

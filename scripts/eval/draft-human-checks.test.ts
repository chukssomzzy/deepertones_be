import { describe, expect, it } from 'vitest'
import { DRAFT_CASES } from './draft-cases'
import { DRAFT_HOLDOUT } from './draft-holdout'
import { HUMAN_CHECKS } from './draft-human-checks'
import { COLUMNS } from './draft-score'

// HUMAN_CHECKS is data a person wrote by hand, and a check that names a case or column that does not exist would silently do nothing.

describe('HUMAN_CHECKS', () => {
  const cases = [...DRAFT_CASES, ...DRAFT_HOLDOUT]

  it('names a case of one of the two sets, and a column or a price row of a country that case asks about', () => {
    for (const check of HUMAN_CHECKS) {
      const found = cases.find((c) => c.id === check.caseId)
      expect(found, check.caseId).toBeDefined()
      if (check.column.startsWith('price:')) expect(found!.countries, `${check.caseId} ${check.column}`).toContain(check.column.slice('price:'.length))
      else expect(COLUMNS, `${check.caseId} ${check.column}`).toContain(check.column)
    }
  })

  it('says who checked, when, what the value was and why', () => {
    for (const check of HUMAN_CHECKS) {
      expect(['correct', 'wrong'], check.caseId).toContain(check.verdict)
      expect(check.checkedOn, check.caseId).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      for (const text of [check.by, check.value, check.note]) expect(text.trim(), check.caseId).not.toBe('')
    }
  })

  it('checks a value once', () => {
    const keys = HUMAN_CHECKS.map((c) => `${c.caseId}|${c.column}|${c.value}`)

    expect(new Set(keys).size).toBe(keys.length)
  })

  it('holds the two values of the Dang case the owner checked on 2026-10-22, both correct', () => {
    const dang = HUMAN_CHECKS.filter((c) => c.caseId === 'dang-vitamin-c-oil-free-serum')

    expect(dang.map((c) => [c.column, c.value, c.verdict, c.checkedOn, c.by])).toEqual([
      ['frequency', 'am-pm', 'correct', '2026-10-22', 'owner'],
      ['price:NG', '14900-17700', 'correct', '2026-10-22', 'owner'],
    ])
  })
})

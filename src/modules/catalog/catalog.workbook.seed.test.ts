import { describe, expect, it } from 'vitest'
import { REFERENCE } from './catalog.reference'
import { seedRuleCode } from './catalog.workbook.seed'

// The seed rules take their codes from REFERENCE (spec #115): `ING-<NAME>-<KIND>`, in capitals, with each run of anything but a letter or digit
// as one hyphen, cut to 40 characters from the end. The migration that seeds `ingredient_rules` and the in-memory repository used by unit
// tests both call this, so a unit test and the migrated database name a rule the same way. The codes below are worked examples, not recomputed.
describe('seedRuleCode', () => {
  it.each([
    [{ name: 'mercury', kind: 'banned-substance' }, 'ING-MERCURY-BANNED-SUBSTANCE'],
    [{ name: 'retinol', kind: 'sun-sensitivity' }, 'ING-RETINOL-SUN-SENSITIVITY'],
    [{ name: 'retinol', kind: 'pregnancy-caution' }, 'ING-RETINOL-PREGNANCY-CAUTION'],
    [{ name: 'aqua (water)', kind: 'irritation' }, 'ING-AQUA-WATER-IRRITATION'],
    [{ name: '1,4-dihydroxybenzene', kind: 'drying' }, 'ING-1-4-DIHYDROXYBENZENE-DRYING'],
  ] as const)('makes %j the code %s', (entry, code) => {
    expect(seedRuleCode(entry)).toBe(code)
  })

  it('cuts a code longer than 40 characters from the end', () => {
    expect(seedRuleCode({ name: 'hydroxyisohexyl 3-cyclohexene carboxaldehyde', kind: 'allergen' })).toBe('ING-HYDROXYISOHEXYL-3-CYCLOHEXENE-CARBOX')
  })

  it('leaves no hyphen at the end of a code the cut would have ended on one', () => {
    // "ING-" and 35 letters is 39 characters, so the hyphen that follows would be the 40th and last.
    expect(seedRuleCode({ name: 'a'.repeat(35), kind: 'drying' })).toBe(`ING-${'A'.repeat(35)}`)
  })

  it('gives every REFERENCE entry a code that fits the workbook code format, at most 40 characters', () => {
    for (const entry of REFERENCE) {
      const code = seedRuleCode(entry)
      expect(code, `${entry.name} / ${entry.kind}`).toMatch(/^ING-[A-Z0-9][A-Z0-9-]*$/)
      expect(code.length, code).toBeLessThanOrEqual(40)
    }
  })

  it('gives the 47 REFERENCE entries 47 different codes, so the seed can use the code as the primary key', () => {
    const codes = REFERENCE.map(seedRuleCode)

    expect(REFERENCE).toHaveLength(47)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('is the same for the same entry every time, whatever else is on it', () => {
    const [entry] = REFERENCE

    expect(seedRuleCode({ name: entry!.name, kind: entry!.kind })).toBe(seedRuleCode(entry!))
  })
})

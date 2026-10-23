import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { REFERENCE } from '../../src/modules/catalog/catalog.reference'
import { seedRuleCode } from '../../src/modules/catalog/catalog.workbook.seed'
import { renderRulesSeedSql, sqlText } from './seed-rules-sql'

// The seed is generated from REFERENCE and appended by hand to the migration that creates the tables (the integration test on the migrated
// database says what it holds); this says the migration still has exactly what the generator writes, so it can always be regenerated.
const MIGRATIONS = 'migrations'

describe('the ingredient rules seed', () => {
  it('is what the migration that creates ingredient_rules ends with', () => {
    const name = readdirSync(MIGRATIONS).find((file) => file.startsWith('0031_') && file.endsWith('.sql'))!

    expect(readFileSync(`${MIGRATIONS}/${name}`, 'utf8').endsWith(renderRulesSeedSql())).toBe(true)
  })

  it('has a statement for the catalog version and one for each REFERENCE entry', () => {
    const statements = renderRulesSeedSql().split('--> statement-breakpoint\n').filter((part) => part !== '')

    expect(statements).toHaveLength(1 + REFERENCE.length)
  })

  it('writes a text as a SQL literal with each single quote doubled, and nothing as NULL', () => {
    expect(sqlText("Don't")).toBe("'Don''t'")
    expect(sqlText("a'b'")).toBe("'a''b'''")
    expect(sqlText(null)).toBe('NULL')
  })

  // The migration and the fake repository must name a rule the same way, so both take the code from the one function the seed module exports.
  it('gives each rule the code seedRuleCode gives its entry', () => {
    const sql = renderRulesSeedSql()

    for (const entry of REFERENCE) expect(sql, `${entry.name} / ${entry.kind}`).toContain(`VALUES (${sqlText(seedRuleCode(entry))}, ${sqlText(entry.name)}, `)
  })

  // The seed is frozen: it is the contract as it stood when the migration shipped. Reading CONTRACT_VERSION here would rewrite the seed
  // (and break the migration test) the day the contract moves to 1.1.0.
  it('writes the catalog version row with contract version 1.0.0 as a literal, never read from the contract', () => {
    const [versionRow] = renderRulesSeedSql().split('--> statement-breakpoint\n').filter((part) => part !== '')

    expect(versionRow).toContain(`VALUES (1, 'seed-2026-10', '1.0.0', 'reference seed', NULL, `)
    expect(readFileSync('scripts/catalog/seed-rules-sql.ts', 'utf8')).not.toMatch(/CONTRACT_VERSION|catalog\.workbook\.(contract|schema)/)
  })
})

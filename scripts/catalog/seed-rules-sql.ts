// The SQL that seeds `ingredient_rules` and `catalog_versions` from REFERENCE, appended to the migration that creates them (migrations/0031_*).
// Run `npx tsx scripts/catalog/seed-rules-sql.ts` to print it again; the test beside this file fails if the migration holds anything else.
import { pathToFileURL } from 'node:url'
import { REFERENCE, REFERENCE_VERSION } from '../../src/modules/catalog/catalog.reference'
import { seedRuleCode } from '../../src/modules/catalog/catalog.workbook.seed'

/** The seed has no author to name, so it says so. */
const SEED_AUTHOR = 'reference seed'
/** The day the seed shipped: a fact about the seed, not a date to keep fresh. */
const SEEDED_ON = '2026-10-21'
/** Midnight UTC of SEEDED_ON, fixed so the migration reads the same however often it is generated. */
const SEEDED_AT = Date.UTC(2026, 9, 21)

// The contract version of the seed's catalog version row. A fact about the seed, like SEEDED_ON: it is what the contract was when the migration
// shipped, so it stays '1.0.0' when the contract moves on. Never read it from the contract module, or the migration's text would change with it.
const SEEDED_CONTRACT = '1.0.0'

/** A SQL text literal: the quote is doubled, which is the only escape SQLite has. */
export const sqlText = (value: string | null): string => (value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`)

export const renderRulesSeedSql = (): string => {
  const codes = new Set<string>()
  const statements = [
    `INSERT INTO \`catalog_versions\` (\`version\`, \`rules_version\`, \`contract_version\`, \`uploaded_by\`, \`archive_key\`, \`created_at\`) VALUES (1, ${sqlText(REFERENCE_VERSION)}, ${sqlText(SEEDED_CONTRACT)}, ${sqlText(SEED_AUTHOR)}, NULL, ${SEEDED_AT});`,
  ]
  for (const entry of REFERENCE) {
    const code = seedRuleCode(entry)
    // Two entries that cut to one code would fail the migration on the primary key; better to fail here, where the entry can be named.
    if (codes.has(code)) throw new Error(`two reference entries have the code ${code}`)
    codes.add(code)
    statements.push(
      `INSERT INTO \`ingredient_rules\` (\`code\`, \`name\`, \`aliases\`, \`kind\`, \`strength_limit\`, \`statement\`, \`source_url\`, \`helps\`, \`status\`, \`approved_by\`, \`approved_on\`, \`audited_by\`, \`audited_on\`, \`updated_in_version\`) VALUES (${sqlText(code)}, ${sqlText(entry.name)}, ${sqlText(JSON.stringify(entry.aliases))}, ${sqlText(entry.kind)}, NULL, ${sqlText(entry.rule)}, ${sqlText(entry.source)}, '[]', 'approved', ${sqlText(SEED_AUTHOR)}, ${sqlText(SEEDED_ON)}, NULL, NULL, 1);`,
    )
  }
  return statements.map((statement) => `--> statement-breakpoint\n${statement}\n`).join('')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(renderRulesSeedSql())

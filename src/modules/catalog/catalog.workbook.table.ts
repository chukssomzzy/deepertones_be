import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { ShownConcern } from '../face-scans/face-scans.tables'
import { CONCERN_KINDS } from './catalog.vocabulary'

/**
 * An ingredient rule: a fact about an ingredient that the analysis must explain, as the workbook's Ingredients tab holds it. Only an
 * approved rule is matched; a draft applies to nothing, and a retired one stays so its code is never reused.
 */
export const ingredientRules = sqliteTable('ingredient_rules', {
  code: text('code').primaryKey(),
  // The name and aliases are stored normalised (normaliseIngredient(x) === x), which is how the matcher compares them.
  name: text('name').notNull(),
  aliases: text('aliases', { mode: 'json' }).$type<string[]>().notNull(),
  kind: text('kind', { enum: CONCERN_KINDS }).notNull(),
  strengthLimit: text('strength_limit'),
  statement: text('statement').notNull(),
  // An https URL for a regulatory listing; null for a commonly cited concern.
  sourceUrl: text('source_url'),
  helps: text('helps', { mode: 'json' }).$type<ShownConcern[]>().notNull(),
  status: text('status', { enum: ['draft', 'approved', 'retired'] }).notNull(),
  approvedBy: text('approved_by'),
  // A calendar day somebody signed on, as the workbook writes it (YYYY-MM-DD), not an instant.
  approvedOn: text('approved_on'),
  auditedBy: text('audited_by'),
  auditedOn: text('audited_on'),
  updatedInVersion: integer('updated_in_version').notNull(),
})

/**
 * One row for every applied upload. The catalog version (`version`) goes up by 1 each time and drives the stale check; the rules version is
 * a string that changes only when the set of approved rules does, and is what `formulations.reference_version` records.
 */
export const catalogVersions = sqliteTable('catalog_versions', {
  version: integer('version').primaryKey(),
  rulesVersion: text('rules_version').notNull(),
  contractVersion: text('contract_version').notNull(),
  uploadedBy: text('uploaded_by').notNull(),
  // Where the uploaded .xlsx was archived; null for the seed, which came from no file.
  archiveKey: text('archive_key'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

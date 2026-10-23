import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { ShownConcern, SkinTypeLabel } from '../face-scans/face-scans.tables'
import { formulations, products } from './catalog.table'
import {
  CATEGORIES,
  CONCERN_KINDS,
  FREQUENCIES,
  ORIGINS,
  PRODUCT_FORMS,
  type ConcernKind,
  type Frequency,
  type Origin,
  type RoutineStep,
} from './catalog.vocabulary'

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

/**
 * A product of the catalog workbook's Products tab, as the last applied upload left it. It is also a catalog product (`product_id`, found by
 * exact identity key or alias) and pins the formulation its list became (`formulation_id`, source 'workbook'), so a recommendation always
 * reads the reviewed list, never whatever list was found latest. A retired row stays, so its code is never reused. The cells are stored as the
 * upload gave them, so an export gives them back.
 */
export const recommendedProducts = sqliteTable(
  'recommended_products',
  {
    code: text('code').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id),
    // Null only for a retired row uploaded with no list; an approved row always has one.
    formulationId: text('formulation_id').references(() => formulations.id),
    brand: text('brand').notNull(),
    name: text('name').notNull(),
    variant: text('variant'),
    form: text('form', { enum: PRODUCT_FORMS }),
    category: text('category', { enum: CATEGORIES }).notNull(),
    ingredients: text('ingredients', { mode: 'json' }).$type<string[]>().notNull(),
    ingredientsSourceUrl: text('ingredients_source_url'),
    skinConcerns: text('skin_concerns', { mode: 'json' }).$type<ShownConcern[]>().notNull(),
    skinTypes: text('skin_types', { mode: 'json' }).$type<(SkinTypeLabel | 'all')[]>().notNull(),
    steps: text('steps', { mode: 'json' }).$type<RoutineStep[]>().notNull(),
    frequency: text('frequency', { enum: FREQUENCIES }).notNull(),
    ownCautions: text('own_cautions', { mode: 'json' }).$type<ConcernKind[]>().notNull(),
    evidenceUrls: text('evidence_urls', { mode: 'json' }).$type<string[]>().notNull(),
    origin: text('origin', { enum: ORIGINS }).notNull(),
    status: text('status', { enum: ['draft', 'approved', 'retired'] }).notNull(),
    approvedBy: text('approved_by'),
    // A calendar day (YYYY-MM-DD), as the workbook writes it, not an instant.
    approvedOn: text('approved_on'),
    auditedBy: text('audited_by'),
    auditedOn: text('audited_on'),
    draftCells: text('draft_cells', { mode: 'json' }).$type<{ column: string; url: string }[]>().notNull(),
    updatedInVersion: integer('updated_in_version').notNull(),
  },
  (t) => [index('recommended_products_product_id_idx').on(t.productId)],
)

/** Where a recommended product is sold and what it costs there. An upload replaces the whole table. */
export const productAvailability = sqliteTable(
  'product_availability',
  {
    productCode: text('product_code')
      .notNull()
      .references(() => recommendedProducts.code),
    country: text('country')
      .notNull()
      .references(() => countries.code),
    priceMin: integer('price_min').notNull(),
    priceMax: integer('price_max').notNull(),
    whereSold: text('where_sold'),
    sourceUrl: text('source_url'),
  },
  (t) => [primaryKey({ columns: [t.productCode, t.country] }), index('product_availability_country_idx').on(t.country)],
)

/** A country the catalog serves: ISO 3166 code, ISO 4217 currency, and where the low and mid price bands end (whole currency units). Retired, never deleted. */
export const countries = sqliteTable('countries', {
  code: text('code').primaryKey(),
  currency: text('currency').notNull(),
  lowMax: integer('low_max').notNull(),
  midMax: integer('mid_max').notNull(),
  status: text('status', { enum: ['active', 'retired'] }).notNull(),
})

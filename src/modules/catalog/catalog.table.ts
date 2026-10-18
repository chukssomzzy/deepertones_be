import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { CATEGORIES, CONCERN_KINDS, PRODUCT_FORMS, SEVERITIES, TRAITS } from './catalog.vocabulary'

/** A product, once for everyone. `identity_key` is built by catalog.identity. */
export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    identityKey: text('identity_key').notNull(),
    brandKey: text('brand_key').notNull(),
    // An unnamed product is a list nobody named: its identity key is "unnamed:" and the list's ingredients key, and its brand and name are ''.
    kind: text('kind', { enum: ['named', 'unnamed'] }).notNull().default('named'),
    brand: text('brand').notNull(),
    name: text('name').notNull(),
    variant: text('variant'),
    form: text('form', { enum: PRODUCT_FORMS }),
    category: text('category', { enum: CATEGORIES }).notNull(),
    // brand, name and variant, normalised (catalog.identity normaliseText), for search; '' for an unnamed product, which search never returns.
    searchText: text('search_text').notNull().default(''),
    imageKey: text('image_key'),
    imageSourceUrl: text('image_source_url'),
    // Set whether or not an image was found, so a product with none is not searched again on every scan.
    imageCheckedAt: integer('image_checked_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('products_identity_key_idx').on(t.identityKey), index('products_brand_key_created_at_idx').on(t.brandKey, t.createdAt)],
)

/** Other spellings that resolved to a product. An alias belongs to one product and never shadows an identity key. */
export const productAliases = sqliteTable(
  'product_aliases',
  {
    aliasKey: text('alias_key').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
  },
  (t) => [index('product_aliases_product_id_idx').on(t.productId)],
)

/** One version of a product's ingredient list. A reformulation is a new row, never an overwrite. */
export const formulations = sqliteTable(
  'formulations',
  {
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    // In label (INCI) order, as a JSON array.
    ingredients: text('ingredients', { mode: 'json' }).$type<string[]>().notNull(),
    ingredientsKey: text('ingredients_key').notNull(),
    sourceKind: text('source_kind', { enum: ['web', 'label'] }).notNull(),
    sourceUrl: text('source_url'),
    foundAt: integer('found_at', { mode: 'timestamp_ms' }).notNull(),
    // Null until analysed.
    analysisVersion: integer('analysis_version'),
    referenceVersion: text('reference_version'),
    analysedAt: integer('analysed_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    index('formulations_product_id_found_at_idx').on(t.productId, t.foundAt),
    // One formulation per ingredient list: concurrent writers of the same list converge on one row.
    uniqueIndex('formulations_product_id_ingredients_key_idx').on(t.productId, t.ingredientsKey),
  ],
)

/** A concern belongs to a formulation as a whole. `position` keeps the order the analysis gave. */
export const formulationConcerns = sqliteTable(
  'formulation_concerns',
  {
    id: text('id').primaryKey(),
    formulationId: text('formulation_id')
      .notNull()
      .references(() => formulations.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: text('kind', { enum: CONCERN_KINDS }).notNull(),
    severity: text('severity', { enum: SEVERITIES }).notNull(),
    ingredients: text('ingredients', { mode: 'json' }).$type<string[]>().notNull(),
    why: text('why').notNull(),
    whoShouldTakeCare: text('who_should_take_care').notNull(),
    sources: text('sources', { mode: 'json' }).$type<string[]>().notNull(),
  },
  (t) => [uniqueIndex('formulation_concerns_formulation_id_position_idx').on(t.formulationId, t.position)],
)

/** The skin traits and goals a concern matters for. */
export const concernTraits = sqliteTable(
  'concern_traits',
  {
    concernId: text('concern_id')
      .notNull()
      .references(() => formulationConcerns.id, { onDelete: 'cascade' }),
    trait: text('trait', { enum: TRAITS }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.concernId, t.trait] })],
)

/**
 * Every attempt to research a new product's ingredients, counted against the daily global cap. An attempt is written
 * as 'started' before the researcher is called and settled afterwards, so a crash in between still counts.
 */
export const researchAttempts = sqliteTable(
  'research_attempts',
  {
    id: text('id').primaryKey(),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    attemptedAt: integer('attempted_at', { mode: 'timestamp_ms' }).notNull(),
    outcome: text('outcome', { enum: ['started', 'found', 'not-found', 'failed'] }).notNull(),
  },
  (t) => [index('research_attempts_attempted_at_idx').on(t.attemptedAt)],
)

/**
 * Every analysis attempt, counted against the daily analysis cap (a failed one is not), and the rejections that stop a
 * formulation being retried for ever. Written as 'started' before the analyst is called and settled afterwards, like a research attempt.
 */
export const analysisAttempts = sqliteTable(
  'analysis_attempts',
  {
    id: text('id').primaryKey(),
    formulationId: text('formulation_id')
      .notNull()
      .references(() => formulations.id, { onDelete: 'cascade' }),
    attemptedAt: integer('attempted_at', { mode: 'timestamp_ms' }).notNull(),
    outcome: text('outcome', { enum: ['started', 'ok', 'rejected', 'failed'] }).notNull(),
    analysisVersion: integer('analysis_version').notNull(),
    referenceVersion: text('reference_version').notNull(),
  },
  (t) => [index('analysis_attempts_attempted_at_idx').on(t.attemptedAt), index('analysis_attempts_formulation_id_idx').on(t.formulationId)],
)

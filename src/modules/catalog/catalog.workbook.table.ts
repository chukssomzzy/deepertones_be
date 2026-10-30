import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { ShownConcern, SkinTypeLabel } from '../face-scans/face-scans.tables'
import { GOALS } from '../goals/goals.vocabulary'
import { formulations, products } from './catalog.table'
import {
  CATEGORIES,
  CONCERN_KINDS,
  ESCALATION_REASONS,
  FREQUENCIES,
  INGREDIENT_GROUPS,
  ORIGINS,
  PRODUCT_FORMS,
  RESPONSE_OUTCOMES,
  ROUTINE_STEPS,
  TAPER_KINDS,
  WEEK_BANDS,
  type ConcernKind,
  type Frequency,
  type IngredientGroup,
  type Origin,
  type RoutineStep,
} from './catalog.vocabulary'
import type { ScheduleStep } from './catalog.workbook.schema'

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
  // Metadata the shelf verdict reads. Neither is part of what the matcher reads, so neither is part of the rules version.
  group: text('group', { enum: INGREDIENT_GROUPS }),
  clashesWith: text('clashes_with', { mode: 'json' }).$type<IngredientGroup[]>().notNull().default([]),
  status: text('status', { enum: ['draft', 'approved', 'retired'] }).notNull(),
  approvedBy: text('approved_by'),
  // The role the app shows under "Reviewed by", like the group and clashes_with above: read by the shelf verdict, so a change to it is not a new rules version. Null for a row stored before 2.4.0.
  reviewerRole: text('reviewer_role'),
  // A calendar day somebody signed on, as the workbook writes it (YYYY-MM-DD), not an instant.
  approvedOn: text('approved_on'),
  auditedBy: text('audited_by'),
  auditedOn: text('audited_on'),
  updatedInVersion: integer('updated_in_version').notNull(),
})

/** A phrase that says a product is sold for lightening, as the workbook's Claim words tab holds it. Only an approved word is matched; a retired one stays so its code is never reused. */
export const claimWords = sqliteTable('claim_words', {
  code: text('code').primaryKey(),
  phrase: text('phrase').notNull(),
  claim: text('claim', { enum: ['lightening'] }).notNull(),
  sourceUrl: text('source_url'),
  status: text('status', { enum: ['approved', 'retired'] }).notNull(),
  approvedBy: text('approved_by'),
  reviewerRole: text('reviewer_role'),
  approvedOn: text('approved_on'),
  auditedBy: text('audited_by'),
  auditedOn: text('audited_on'),
  updatedInVersion: integer('updated_in_version').notNull(),
})

/** A step-down template, as the workbook's Tapers tab holds it. Retired, never deleted, so a past routine can still say which plan it used. */
export const tapers = sqliteTable('tapers', {
  code: text('code').primaryKey(),
  kind: text('kind', { enum: TAPER_KINDS }).notNull(),
  schedule: text('schedule', { mode: 'json' }).$type<ScheduleStep[]>().notNull(),
  whatToExpect: text('what_to_expect').notNull(),
  seeAProfessionalIf: text('see_a_professional_if').notNull(),
  status: text('status', { enum: ['draft', 'approved', 'retired'] }).notNull(),
  approvedBy: text('approved_by'),
  approvedOn: text('approved_on'),
  auditedBy: text('audited_by'),
  auditedOn: text('audited_on'),
  updatedInVersion: integer('updated_in_version').notNull(),
})

/**
 * A routine guide, as the workbook's Guides tab holds it: what a step is for, what to look for and what suits deeper skin, for a step and optionally a goal. A guide has
 * no code: `key` is its step, or `step:goal` for a goal (`guideKey`), and is the primary key. It is not (step, goal), because SQLite counts a null goal as different from
 * every other, so a step's base guide would be a new row on every upload. Retired, never deleted.
 */
export const guides = sqliteTable('guides', {
  key: text('key').primaryKey(),
  step: text('step', { enum: ROUTINE_STEPS }).notNull(),
  goal: text('goal', { enum: GOALS }),
  whatItDoes: text('what_it_does').notNull(),
  lookFor: text('look_for').notNull(),
  forDeeperSkin: text('for_deeper_skin').notNull(),
  lookForWhenPregnant: text('look_for_when_pregnant'),
  status: text('status', { enum: ['draft', 'approved', 'retired'] }).notNull(),
  approvedBy: text('approved_by'),
  approvedOn: text('approved_on'),
  auditedBy: text('audited_by'),
  auditedOn: text('audited_on'),
  updatedInVersion: integer('updated_in_version').notNull(),
})

/**
 * A reintroduction ladder, as the workbook's Reintroductions tab holds it: how a paused product is brought back slowly. A ladder is identified by its group, and `key` is
 * that group, or `default` for the ladder with none (`reintroductionKey`), and is the primary key: SQLite counts a null group as different from every other, so a composite
 * key could not hold the default ladder. Retired, never deleted.
 */
export const reintroductions = sqliteTable('reintroductions', {
  key: text('key').primaryKey(),
  group: text('group', { enum: INGREDIENT_GROUPS }),
  schedule: text('schedule', { mode: 'json' }).$type<ScheduleStep[]>().notNull(),
  status: text('status', { enum: ['draft', 'approved', 'retired'] }).notNull(),
  approvedBy: text('approved_by'),
  approvedOn: text('approved_on'),
  auditedBy: text('audited_by'),
  auditedOn: text('audited_on'),
  updatedInVersion: integer('updated_in_version').notNull(),
})

/** What the app tells a person when it sends them to a professional, as the workbook's Escalations tab holds it. `key` is the reason. Retired, never deleted. */
export const escalations = sqliteTable('escalations', {
  key: text('key').primaryKey(),
  reason: text('reason', { enum: ESCALATION_REASONS }).notNull(),
  whoToSee: text('who_to_see').notNull(),
  howSoon: text('how_soon').notNull(),
  whatToTellThem: text('what_to_tell_them').notNull(),
  status: text('status', { enum: ['draft', 'approved', 'retired'] }).notNull(),
  approvedBy: text('approved_by'),
  approvedOn: text('approved_on'),
  auditedBy: text('audited_by'),
  auditedOn: text('audited_on'),
  updatedInVersion: integer('updated_in_version').notNull(),
})

/** The text that answers a skin log or a check-in after a pause, as the workbook's Responses tab holds it. `key` is the outcome. The texts may hold `{step}`. Retired, never deleted. */
export const responses = sqliteTable('responses', {
  key: text('key').primaryKey(),
  outcome: text('outcome', { enum: RESPONSE_OUTCOMES }).notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  whatToDoNow: text('what_to_do_now'),
  status: text('status', { enum: ['draft', 'approved', 'retired'] }).notNull(),
  approvedBy: text('approved_by'),
  approvedOn: text('approved_on'),
  auditedBy: text('audited_by'),
  auditedOn: text('audited_on'),
  updatedInVersion: integer('updated_in_version').notNull(),
})

/**
 * A week card on Today, as the workbook's Weeks tab holds it. `key` is the band, then `:<goal>` for a goal, then `:step-down` for a step-down (`weekKey`), and is the
 * primary key, for the reason a ladder's is. Retired, never deleted.
 */
export const weeks = sqliteTable('weeks', {
  key: text('key').primaryKey(),
  band: text('band', { enum: WEEK_BANDS }).notNull(),
  goal: text('goal', { enum: GOALS }),
  stepDown: integer('step_down', { mode: 'boolean' }).notNull(),
  title: text('title').notNull(),
  text: text('text').notNull(),
  status: text('status', { enum: ['draft', 'approved', 'retired'] }).notNull(),
  approvedBy: text('approved_by'),
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
    keyIngredient: text('key_ingredient'),
    strength: text('strength'),
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

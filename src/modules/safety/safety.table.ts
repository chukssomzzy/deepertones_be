import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { profiles } from '../profiles/profiles.table'
import type { SafetyChoice } from './safety.vocabulary'

/**
 * A profile's safety answers, as history: every change appends a row and the newest by `created_at` is the current one, read through the
 * (profile_id, created_at) index. `choices` is a JSON array of the ticked choices in the vocabulary's order. The two texts are what the user
 * typed beside "a product gave me a reaction" and "I use a prescription", trimmed, and null when nothing was typed. They are personal, so
 * they never reach a log. Rows go with their profile (cascade), so guest cleanup needs no cleaner of its own.
 *
 * `parse_state` is where the background parse of the two texts has got to: `none` when there is nothing to parse (and for every row written
 * before the parse existed), `pending` from the save until the parse finishes, then `done`, or `failed` when its retries ran out. `parse_due_at` is
 * when the parse was meant to run (a save within the hour of the last one waits for it); a row still `pending` long after it is queued again.
 */
export const profileSafety = sqliteTable(
  'profile_safety',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    choices: text('choices', { mode: 'json' }).$type<SafetyChoice[]>().notNull(),
    reactionText: text('reaction_text'),
    prescriptionText: text('prescription_text'),
    parseState: text('parse_state', { enum: ['none', 'pending', 'done', 'failed'] })
      .notNull()
      .default('none'),
    parseDueAt: integer('parse_due_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('profile_safety_profile_id_created_at_idx').on(t.profileId, t.createdAt)],
)

/**
 * The products and ingredients the parse found in one answer's two texts, in the order found (`position` counts on through the second text). Rows
 * go with their safety row (cascade). `brand`, `variant` and `category` are what the reader gave and are null for an ingredient. `product_id` points
 * into the catalog, which is not this module's, so it carries no foreign key. `resolution` is null for an ingredient, `pending` for a product still
 * to look up, and `resolved` or `unresolved` once it has been (an unresolved product may keep the catalog's id, when research found no ingredients).
 * The words are personal, so they never reach a log.
 */
export const safetyMentions = sqliteTable(
  'safety_mentions',
  {
    id: text('id').primaryKey(),
    safetyId: text('safety_id')
      .notNull()
      .references(() => profileSafety.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['reaction', 'prescription'] }).notNull(),
    kind: text('kind', { enum: ['product', 'ingredient'] }).notNull(),
    brand: text('brand'),
    name: text('name').notNull(),
    variant: text('variant'),
    category: text('category'),
    productId: text('product_id'),
    resolution: text('resolution', { enum: ['pending', 'resolved', 'unresolved'] }),
    position: integer('position').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('safety_mentions_safety_id_position_idx').on(t.safetyId, t.position)],
)

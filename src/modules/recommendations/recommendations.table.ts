import { index, sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { BUDGET_BANDS } from '../catalog/catalog.vocabulary'
import { profiles } from '../profiles/profiles.table'

/**
 * Where a profile shops and what it is happy to spend, as history: every change appends a row and the newest by `created_at` is the current
 * one, read through the (profile_id, created_at) index. `country` is a code from the catalog's Countries tab, which is not this module's, so it
 * carries no foreign key (a country is retired, never deleted, so a stored code keeps meaning something). `budget_band` is null when the user
 * gave none, and the newest row decides, so a band is taken back by saving the country alone. Rows go with their profile (cascade), so guest
 * cleanup needs no cleaner of its own.
 */
export const profileShopping = sqliteTable(
  'profile_shopping',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    country: text('country').notNull(),
    budgetBand: text('budget_band', { enum: BUDGET_BANDS }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('profile_shopping_profile_id_created_at_idx').on(t.profileId, t.createdAt)],
)

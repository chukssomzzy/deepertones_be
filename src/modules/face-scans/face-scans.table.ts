import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { REJECTED_PHOTO_REASONS } from '../../providers/perfect-corp/perfect-corp.provider'
import { GOALS } from '../goals/goals.vocabulary'
import { profiles } from '../profiles/profiles.table'

// Every table here carries `user_id`, as the scan tables do, so the guest cleanup can find a user's rows without a join. Each cascades
// from `profiles` (a face belongs to a profile, not to an account) and the child tables from `face_scans`. The cascade clears rows but
// never the bucket, so FaceDataCleaner deletes the photos and masks first.

/** One consent per profile, kept when it is withdrawn so the app can show that it was. Giving again overwrites the row. */
export const faceConsents = sqliteTable(
  'face_consents',
  {
    profileId: text('profile_id')
      .primaryKey()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    version: integer('version').notNull(),
    givenAt: integer('given_at', { mode: 'timestamp_ms' }).notNull(),
    withdrawnAt: integer('withdrawn_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('face_consents_user_id_idx').on(t.userId)],
)

/**
 * One face scan of one profile. `goal_at_scan` is the goal it was taken under, which is what "a rescan is suggested" is worked out
 * from when it is read. The `pc_*` columns are Perfect Corp's task ids and the Perfect Corp environment the tasks were made in (a
 * webhook for another environment's task is ignored); the skin age, skin type and tables version are written when a result comes back.
 */
export const faceScans = sqliteTable(
  'face_scans',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ['analysing', 'needs-retake', 'ready', 'failed'] })
      .notNull()
      .default('analysing'),
    // Why the scan failed or needs a retake. The retake reasons are REJECTED_PHOTO_REASONS (the Perfect Corp provider's fixed set); the column is plain text in SQL.
    reason: text('reason', { enum: ['unavailable', 'consent-withdrawn', ...REJECTED_PHOTO_REASONS] }),
    goalAtScan: text('goal_at_scan', { enum: GOALS }).notNull(),
    pcAnalysisTaskId: text('pc_analysis_task_id'),
    pcFitzpatrickTaskId: text('pc_fitzpatrick_task_id'),
    pcEnvironment: text('pc_environment'),
    skinAge: integer('skin_age'),
    skinType: text('skin_type', { enum: ['oily', 'dry', 'combination', 'normal'] }),
    tablesVersion: text('tables_version'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    // When the reaper queued its one check of this scan; null until it has. Last, because createFaceScan's INSERT ... SELECT lists the columns by position.
    reaperCheckedAt: integer('reaper_checked_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    // (profile_id, created_at) serves "the latest scan of this profile".
    index('face_scans_profile_id_created_at_idx').on(t.profileId, t.createdAt),
    index('face_scans_user_id_idx').on(t.userId),
    // A webhook finds its scan by either task id; (state, updated_at) serves the reaper's "analysing for longest".
    index('face_scans_pc_analysis_task_id_idx').on(t.pcAnalysisTaskId),
    index('face_scans_pc_fitzpatrick_task_id_idx').on(t.pcFitzpatrickTaskId),
    index('face_scans_state_updated_at_idx').on(t.state, t.updatedAt),
  ],
)

/** The photos of a scan, at most one per position. The key is under faces/ in the private bucket. */
export const faceScanPhotos = sqliteTable(
  'face_scan_photos',
  {
    faceScanId: text('face_scan_id')
      .notNull()
      .references(() => faceScans.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    position: text('position', { enum: ['front', 'right', 'left'] }).notNull(),
    photoKey: text('photo_key').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.faceScanId, t.position] }), index('face_scan_photos_user_id_idx').on(t.userId)],
)

/** What Perfect Corp measured, per concern and region. `raw_score` is the one the rules read; `ui_score` is kept as returned and never shown. */
export const faceResults = sqliteTable(
  'face_results',
  {
    faceScanId: text('face_scan_id')
      .notNull()
      .references(() => faceScans.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    concern: text('concern').notNull(),
    region: text('region').notNull(),
    rawScore: real('raw_score').notNull(),
    uiScore: real('ui_score').notNull(),
  },
  (t) => [primaryKey({ columns: [t.faceScanId, t.concern, t.region] }), index('face_results_user_id_idx').on(t.userId)],
)

/** The overlay mask of a concern: a PNG key under faces/ in the private bucket. */
export const faceMasks = sqliteTable(
  'face_masks',
  {
    faceScanId: text('face_scan_id')
      .notNull()
      .references(() => faceScans.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    concern: text('concern').notNull(),
    maskKey: text('mask_key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.faceScanId, t.concern] }), index('face_masks_user_id_idx').on(t.userId)],
)

/** The Fitzpatrick type (I to VI) read from a profile's first face scan, and the Perfect Corp task that read it. Never shown. */
export const profileFitzpatrick = sqliteTable(
  'profile_fitzpatrick',
  {
    profileId: text('profile_id')
      .primaryKey()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    fitzpatrick: text('fitzpatrick', { enum: ['I', 'II', 'III', 'IV', 'V', 'VI'] }).notNull(),
    taskId: text('task_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('profile_fitzpatrick_user_id_idx').on(t.userId)],
)

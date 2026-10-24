import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { chunked, type Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import type { Goal } from '../goals/goals.vocabulary'
import { faceConsents, faceMasks, faceResults, faceScanPhotos, faceScans, profileFitzpatrick } from './face-scans.table'
import type {
  FaceConsent,
  FaceMask,
  FaceResult,
  FaceScan,
  FaceScanCompletion,
  FaceScanPatch,
  FaceScanPhoto,
  FaceScanState,
  GiveFaceConsent,
  NewFacePhoto,
  NewFaceScan,
  ProfileFitzpatrick,
} from './face-scans.types'

export type { FaceConsent, FaceMask, FaceResult, FaceScan, FaceScanCompletion, FaceScanPatch, FaceScanPhoto, GiveFaceConsent, NewFacePhoto, NewFaceScan, ProfileFitzpatrick }

const batchOf = (statements: BatchItem<'sqlite'>[]) => statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]

export class D1FaceScansRepository {
  constructor(private readonly db: Db) {}

  /** The profile's consent, or null if it never gave one. A withdrawn consent is still here, with its withdrawal time. */
  async consentOf(profileId: string): Promise<FaceConsent | null> {
    const [row] = await this.db.select().from(faceConsents).where(eq(faceConsents.profileId, profileId))
    return row ?? null
  }

  /** Records consent at `at`: a profile has one row, and giving again replaces its version and time and clears any withdrawal. */
  async giveConsent(consent: GiveFaceConsent): Promise<void> {
    const { profileId, userId, version, at } = consent
    await this.db
      .insert(faceConsents)
      .values({ profileId, userId, version, givenAt: at, withdrawnAt: null })
      .onConflictDoUpdate({ target: faceConsents.profileId, set: { userId, version, givenAt: at, withdrawnAt: null } })
  }

  /** Stamps the time of the withdrawal and keeps the row. The first withdrawal's time stands; a profile with no consent gets no row. */
  async withdrawConsent(profileId: string, at: Date): Promise<void> {
    await this.db
      .update(faceConsents)
      .set({ withdrawnAt: at })
      .where(and(eq(faceConsents.profileId, profileId), isNull(faceConsents.withdrawnAt)))
  }

  /**
   * Stores the scan, `analysing` with `updatedAt` equal to `createdAt`, and its photos, or nothing (one batch), and says whether it did. Rejects if the id
   * is taken or two photos share a position.
   *
   * With `expectLatestId` the write is conditional, to stop two requests that both saw the same latest scan from both storing one: the scan (and so its photos)
   * is stored only if the profile's latest scan that has not failed (the one `latestForProfile` answers) is that id, or there is none when it is null.
   * The test is part of the INSERT ... SELECT, so it and the write are one atomic step; the photos are inserted only where that scan row now exists. False
   * means nothing was stored. Without the option the write is unconditional and the answer is true.
   */
  async createFaceScan(scan: NewFaceScan, photos: NewFacePhoto[], options?: { expectLatestId: string | null }): Promise<boolean> {
    if (!options) {
      const statements: BatchItem<'sqlite'>[] = [
        this.db.insert(faceScans).values({ ...scan, checkIn: scan.checkIn ?? false, updatedAt: scan.createdAt }),
        ...photos.map((photo) => this.db.insert(faceScanPhotos).values(photo)),
      ]
      await this.db.batch(batchOf(statements))
      return true
    }
    const at = scan.createdAt.getTime()
    const checkIn = scan.checkIn ? 1 : 0
    // insert ... select takes its values by column position, so each select lists the table's columns in order.
    const statements: BatchItem<'sqlite'>[] = [
      this.db
        .insert(faceScans)
        .select(
          sql`SELECT ${scan.id}, ${scan.userId}, ${scan.profileId}, 'analysing', NULL, ${scan.goalAtScan}, NULL, NULL, NULL, NULL, NULL, NULL, ${at}, ${at}, NULL, ${checkIn}
            WHERE (SELECT id FROM ${faceScans} WHERE ${faceScans.profileId} = ${scan.profileId} AND ${faceScans.state} <> 'failed' ORDER BY ${faceScans.createdAt} DESC, rowid DESC LIMIT 1) IS ${options.expectLatestId}`,
        )
        .returning({ id: faceScans.id }),
      ...photos.map((photo) =>
        this.db
          .insert(faceScanPhotos)
          .select(
            sql`SELECT ${photo.faceScanId}, ${photo.userId}, ${photo.position}, ${photo.photoKey}, ${photo.createdAt.getTime()}
              WHERE EXISTS (SELECT 1 FROM ${faceScans} WHERE ${faceScans.id} = ${scan.id})`,
          ),
      ),
    ]
    const [inserted] = await this.db.batch(batchOf(statements))
    return (inserted as { id: string }[]).length === 1
  }

  async findFaceScan(id: string): Promise<FaceScan | null> {
    const [row] = await this.db.select().from(faceScans).where(eq(faceScans.id, id))
    return row ?? null
  }

  /** The scan's photos, front then right then left. */
  async photosOf(faceScanId: string): Promise<FaceScanPhoto[]> {
    return this.db
      .select()
      .from(faceScanPhotos)
      .where(eq(faceScanPhotos.faceScanId, faceScanId))
      .orderBy(asc(sql`case ${faceScanPhotos.position} when 'front' then 0 when 'right' then 1 else 2 end`))
  }

  /**
   * The profile's newest scan that has not failed (a failed scan gave it nothing to look at), or null. Scans made at the same time
   * go to the one written last, so the answer is the same every time.
   */
  async latestForProfile(profileId: string): Promise<FaceScan | null> {
    const [row] = await this.db
      .select()
      .from(faceScans)
      .where(and(eq(faceScans.profileId, profileId), ne(faceScans.state, 'failed')))
      .orderBy(desc(faceScans.createdAt), sql`rowid desc`)
      .limit(1)
    return row ?? null
  }

  /**
   * The profile's newest scan that is `ready`, or null. Unlike `latestForProfile`, a newer scan that is analysing or needs a retake does not hide it: a
   * reader of what a scan found (the skin type) wants the last scan that found something. Scans made at the same time go to the one written last.
   */
  async latestReadyForProfile(profileId: string): Promise<FaceScan | null> {
    const [row] = await this.db
      .select()
      .from(faceScans)
      .where(and(eq(faceScans.profileId, profileId), eq(faceScans.state, 'ready')))
      .orderBy(desc(faceScans.createdAt), sql`rowid desc`)
      .limit(1)
    return row ?? null
  }

  /** The profile's newest `limit` scans, in every state, newest first; scans made at the same time go to the higher id. */
  async listForProfile(profileId: string, limit: number): Promise<FaceScan[]> {
    return this.db.select().from(faceScans).where(eq(faceScans.profileId, profileId)).orderBy(desc(faceScans.createdAt), desc(faceScans.id)).limit(limit)
  }

  /**
   * The day-one scan of the chase that the scan taken at `at` belongs to: the profile's earliest `ready` scan under `goal`, taken no earlier
   * than `since` (the start of that chase, worked out by the caller from the goal history) and no later than `at`. It is the scan itself when
   * nothing earlier qualifies, and null when no ready scan does. Only ready scans count: one that failed, needs a retake or is analysing is
   * never a day one. A scan under another goal inside the window is no cut-off here: the chase already decided that for the caller, by way
   * of `since`.
   *
   * `since` and the upper bound (`at`) are by timestamp alone, and candidates that share a timestamp go to the lower id. Two scans of one
   * profile cannot share a millisecond in practice (each is a person's upload), so no scan is ever ordered against itself by id. `scanId` is
   * kept for that tie-break, should one be needed.
   */
  async dayOneFor({ profileId, goal, at, since }: { profileId: string; goal: Goal; at: Date; since: Date; scanId: string }): Promise<FaceScan | null> {
    const [row] = await this.db
      .select()
      .from(faceScans)
      .where(
        and(eq(faceScans.profileId, profileId), eq(faceScans.state, 'ready'), eq(faceScans.goalAtScan, goal), gte(faceScans.createdAt, since), lte(faceScans.createdAt, at)),
      )
      .orderBy(asc(faceScans.createdAt), asc(faceScans.id))
      .limit(1)
    return row ?? null
  }

  /**
   * Every scan the profile has under `goal` since `since` (the start of the chase the caller worked out from the goal history, inclusive), whatever
   * state it is in: the due rule's own read (issue #145). The read judges nothing; the policy decides what a failed, analysing or check-in scan means.
   */
  async scansUnderGoalSince(profileId: string, goal: Goal, since: Date): Promise<FaceScan[]> {
    return this.db.select().from(faceScans).where(and(eq(faceScans.profileId, profileId), eq(faceScans.goalAtScan, goal), gte(faceScans.createdAt, since)))
  }

  /**
   * Applies the patch only while the scan is still in `expected`, and says whether it did (one conditional UPDATE, so of two simultaneous callers exactly one wins).
   * With `onlyIfNoAnalysisTask` it also holds only while the scan has no analysis task, so of two uploads that both created a task the first to store keeps its own.
   */
  async updateFaceScan(id: string, expected: FaceScanState, patch: FaceScanPatch, options?: { onlyIfNoAnalysisTask?: true }): Promise<boolean> {
    const rows = await this.db
      .update(faceScans)
      .set(patch)
      .where(and(eq(faceScans.id, id), eq(faceScans.state, expected), options?.onlyIfNoAnalysisTask ? isNull(faceScans.pcAnalysisTaskId) : undefined))
      .returning({ id: faceScans.id })
    return rows.length > 0
  }

  /**
   * Notes the reaper's check of an `analysing` scan that has not been checked yet, and says whether it did. It writes only that column, so a scan that moved on
   * after the caller read it keeps its own updated time (the 2-hour clock is the scan's, not the check's), and of two simultaneous reapers exactly one wins.
   */
  async markReaperChecked(id: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(faceScans)
      .set({ reaperCheckedAt: at })
      .where(and(eq(faceScans.id, id), eq(faceScans.state, 'analysing'), isNull(faceScans.reaperCheckedAt)))
      .returning({ id: faceScans.id })
    return rows.length > 0
  }

  /** The scan whose analysis task or Fitzpatrick task this is, or null. Task ids are Perfect Corp's and unique, so at most one scan holds one. */
  async findByTaskId(taskId: string): Promise<FaceScan | null> {
    const [row] = await this.db
      .select()
      .from(faceScans)
      .where(or(eq(faceScans.pcAnalysisTaskId, taskId), eq(faceScans.pcFitzpatrickTaskId, taskId)))
      .limit(1)
    return row ?? null
  }

  /**
   * Scans still `analysing` whose updated time is strictly before `before`, the longest-waiting first, at most `limit`. With `unchecked` only those the reaper has
   * not checked yet, so scans it has already looked at cannot fill the limit.
   */
  async staleAnalysing(before: Date, limit: number, options?: { unchecked?: true }): Promise<FaceScan[]> {
    return this.db
      .select()
      .from(faceScans)
      .where(and(eq(faceScans.state, 'analysing'), lt(faceScans.updatedAt, before), options?.unchecked ? isNull(faceScans.reaperCheckedAt) : undefined))
      .orderBy(asc(faceScans.updatedAt), sql`rowid`)
      .limit(limit)
  }

  /**
   * Stores a finished analysis and makes the scan `ready`, or stores nothing, in one batch, and says whether it did. The rows are written only while the scan
   * exists and is still `analysing` (so a scan deleted meanwhile gives false instead of a foreign key error, and a scan that moved on keeps what it has), and
   * the UPDATE is last, so its answer is the answer for the batch. A row that cannot be stored (the same concern and region twice) fails the whole batch.
   */
  async completeFaceScan(id: string, completion: FaceScanCompletion): Promise<boolean> {
    const stillAnalysing = sql`WHERE EXISTS (SELECT 1 FROM ${faceScans} WHERE ${faceScans.id} = ${id} AND ${faceScans.state} = 'analysing')`
    // insert ... select takes its values by column position, so each select lists the table's columns in order.
    const statements: BatchItem<'sqlite'>[] = [
      ...completion.results.map((row) =>
        this.db.insert(faceResults).select(sql`SELECT ${row.faceScanId}, ${row.userId}, ${row.concern}, ${row.region}, ${row.rawScore}, ${row.uiScore} ${stillAnalysing}`),
      ),
      ...completion.masks.map((row) => this.db.insert(faceMasks).select(sql`SELECT ${row.faceScanId}, ${row.userId}, ${row.concern}, ${row.maskKey} ${stillAnalysing}`)),
      this.db
        .update(faceScans)
        .set({ state: 'ready', skinType: completion.skinType, skinAge: completion.skinAge, tablesVersion: completion.tablesVersion, updatedAt: completion.updatedAt })
        .where(and(eq(faceScans.id, id), eq(faceScans.state, 'analysing')))
        .returning({ id: faceScans.id }),
    ]
    const answers = await this.db.batch(batchOf(statements))
    return (answers.at(-1) as { id: string }[]).length === 1
  }

  async resultsOf(faceScanId: string): Promise<FaceResult[]> {
    return this.db.select().from(faceResults).where(eq(faceResults.faceScanId, faceScanId))
  }

  async masksOf(faceScanId: string): Promise<FaceMask[]> {
    return this.db.select().from(faceMasks).where(eq(faceMasks.faceScanId, faceScanId))
  }

  async fitzpatrickOf(profileId: string): Promise<ProfileFitzpatrick | null> {
    const [row] = await this.db.select().from(profileFitzpatrick).where(eq(profileFitzpatrick.profileId, profileId))
    return row ?? null
  }

  /** Stores the profile's Fitzpatrick type unless it already has one: the first read stands, so a job run twice changes nothing. */
  async saveFitzpatrick(row: ProfileFitzpatrick): Promise<void> {
    await this.db.insert(profileFitzpatrick).values(row).onConflictDoNothing({ target: profileFitzpatrick.profileId })
  }

  /** Every bucket key the scan holds: its photos and its masks. */
  async keysOfFaceScan(faceScanId: string): Promise<string[]> {
    const photos = await this.db.select({ key: faceScanPhotos.photoKey }).from(faceScanPhotos).where(eq(faceScanPhotos.faceScanId, faceScanId))
    const masks = await this.db.select({ key: faceMasks.maskKey }).from(faceMasks).where(eq(faceMasks.faceScanId, faceScanId))
    return [...photos, ...masks].map((row) => row.key)
  }

  /** Deletes the scan with its photos, results and masks, in one batch. Not an error if it is already gone. */
  async deleteFaceScan(id: string): Promise<void> {
    await this.db.batch([
      this.db.delete(faceResults).where(eq(faceResults.faceScanId, id)),
      this.db.delete(faceMasks).where(eq(faceMasks.faceScanId, id)),
      this.db.delete(faceScanPhotos).where(eq(faceScanPhotos.faceScanId, id)),
      this.db.delete(faceScans).where(eq(faceScans.id, id)),
    ])
  }

  /** Every bucket key (photos and masks) held for these users. */
  async photoKeysForUsers(userIds: string[]): Promise<string[]> {
    const keys: string[] = []
    for (const ids of chunked(userIds)) {
      const photos = await this.db.select({ key: faceScanPhotos.photoKey }).from(faceScanPhotos).where(inArray(faceScanPhotos.userId, ids))
      const masks = await this.db.select({ key: faceMasks.maskKey }).from(faceMasks).where(inArray(faceMasks.userId, ids))
      keys.push(...photos.map((row) => row.key), ...masks.map((row) => row.key))
    }
    return keys
  }

  /** Deletes these users' face data in one batch: results, masks, photos, scans, Fitzpatrick reads and consents. Safe to repeat; an empty list deletes nothing. */
  async deleteForUsers(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return
    const statements: BatchItem<'sqlite'>[] = chunked(userIds).flatMap((ids) => [
      this.db.delete(faceResults).where(inArray(faceResults.userId, ids)),
      this.db.delete(faceMasks).where(inArray(faceMasks.userId, ids)),
      this.db.delete(faceScanPhotos).where(inArray(faceScanPhotos.userId, ids)),
      this.db.delete(faceScans).where(inArray(faceScans.userId, ids)),
      this.db.delete(profileFitzpatrick).where(inArray(profileFitzpatrick.userId, ids)),
      this.db.delete(faceConsents).where(inArray(faceConsents.userId, ids)),
    ])
    await this.db.batch(batchOf(statements))
  }
}

export type FaceScansRepository = PublicOf<D1FaceScansRepository>

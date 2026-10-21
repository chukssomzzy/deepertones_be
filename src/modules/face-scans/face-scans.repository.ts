import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { chunked, type Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { faceConsents, faceMasks, faceResults, faceScanPhotos, faceScans, profileFitzpatrick } from './face-scans.table'
import type { FaceConsent, FaceScan, FaceScanPatch, FaceScanPhoto, FaceScanState, GiveFaceConsent, NewFacePhoto, NewFaceScan } from './face-scans.types'

export type { FaceConsent, FaceScan, FaceScanPatch, FaceScanPhoto, GiveFaceConsent, NewFacePhoto, NewFaceScan }

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
        this.db.insert(faceScans).values({ ...scan, updatedAt: scan.createdAt }),
        ...photos.map((photo) => this.db.insert(faceScanPhotos).values(photo)),
      ]
      await this.db.batch(batchOf(statements))
      return true
    }
    const at = scan.createdAt.getTime()
    // insert ... select takes its values by column position, so each select lists the table's columns in order.
    const statements: BatchItem<'sqlite'>[] = [
      this.db
        .insert(faceScans)
        .select(
          sql`SELECT ${scan.id}, ${scan.userId}, ${scan.profileId}, 'analysing', NULL, ${scan.goalAtScan}, NULL, NULL, NULL, NULL, NULL, NULL, ${at}, ${at}
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

  /** Applies the patch only while the scan is still in `expected`, and says whether it did (one conditional UPDATE, so of two simultaneous callers exactly one wins). */
  async updateFaceScan(id: string, expected: FaceScanState, patch: FaceScanPatch): Promise<boolean> {
    const rows = await this.db
      .update(faceScans)
      .set(patch)
      .where(and(eq(faceScans.id, id), eq(faceScans.state, expected)))
      .returning({ id: faceScans.id })
    return rows.length > 0
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

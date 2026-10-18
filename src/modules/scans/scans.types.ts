import type { scanBackPhotos, scanItems, scanPhotos, scanRetakes, scans } from './scans.table'

export type ScanKind = NonNullable<typeof scans.$inferSelect.kind>
/** The column is nullable in SQL (see the table); the repository reads NULL as 'product', so a Scan always has a kind. */
export type Scan = Omit<typeof scans.$inferSelect, 'kind'> & { kind: ScanKind }
export type ScanPhoto = typeof scanPhotos.$inferSelect
export type ScanItem = typeof scanItems.$inferSelect

export type ItemState = ScanItem['state']
/** The states in which a front photo is still wanted: it may be shown to the user for a decision. In any other state it is released. */
export const PHOTO_HELD_STATES: readonly ItemState[] = ['recognising', 'needs-confirmation']
export type ItemReason = NonNullable<ScanItem['reason']>

/** The column is nullable in SQL (see the table), but a new scan always has its profile. */
export type NewScan = Omit<Scan, 'doneAt' | 'profileId'> & { profileId: string }

/** What a new photo needs: it always starts `recognising`, with no recognition and nothing skipped. */
export type NewScanPhoto = Pick<ScanPhoto, 'id' | 'scanId' | 'userId' | 'position' | 'photoKey' | 'createdAt'>

/** A back photo upload, to be counted against the daily quotas. */
export type NewBackPhoto = typeof scanBackPhotos.$inferInsert

/** A retaken front photo, to be counted against the daily quotas. */
export type NewRetake = typeof scanRetakes.$inferInsert

/** What a new item needs: it always starts `recognising`, with no reason, no recognised fields, no product and no back photo. */
export type NewScanItem = Pick<ScanItem, 'id' | 'scanId' | 'userId' | 'position' | 'createdAt'> & { photoId: string; photoKey: string | null }

/** A change to an item: any column but its identity, and when it was made. A field left out is unchanged; null clears it. */
export type ItemPatch = Partial<Omit<ScanItem, 'id' | 'scanId' | 'userId' | 'position' | 'createdAt' | 'updatedAt'>> & { updatedAt: Date }

/** A change to a scan photo when it is read: any of its state, key, answer and skipped counts. `photoKey: null` clears the key. */
export type PhotoPatch = Partial<Pick<ScanPhoto, 'state' | 'photoKey' | 'recognition' | 'skippedNotBeauty' | 'skippedUnreadable' | 'skippedOverLimit' | 'skippedDailyLimit'>> & { updatedAt: Date }

/** A further product read on a shelf photo, stored as a new item where the read leaves it: it has no image of its own, and no product yet. */
export type NewSibling = NewScanItem & {
  state: 'matching' | 'needs-confirmation'
  recognisedBrand: string
  recognisedName: string
  recognisedVariant: string | null
  recognisedForm: ScanItem['recognisedForm']
  recognisedCategory: NonNullable<ScanItem['recognisedCategory']>
  recognisedConfidence: number
}

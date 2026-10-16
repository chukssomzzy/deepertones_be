import type { scanBackPhotos, scanItems, scans } from './scans.table'

export type Scan = typeof scans.$inferSelect
export type ScanItem = typeof scanItems.$inferSelect

export type ItemState = ScanItem['state']
export type ItemReason = NonNullable<ScanItem['reason']>

/** The column is nullable in SQL (see the table), but a new scan always has its profile. */
export type NewScan = Omit<Scan, 'doneAt' | 'profileId'> & { profileId: string }

/** A back photo upload, to be counted against the daily quotas. */
export type NewBackPhoto = typeof scanBackPhotos.$inferInsert

/** What a new item needs: it always starts `recognising`, with no reason, no recognised fields, no product and no back photo. */
export type NewScanItem = Pick<ScanItem, 'id' | 'scanId' | 'userId' | 'position' | 'createdAt'> & { photoKey: string }

/** A change to an item: any column but its identity, and when it was made. A field left out is unchanged; null clears it. */
export type ItemPatch = Partial<Omit<ScanItem, 'id' | 'scanId' | 'userId' | 'position' | 'createdAt' | 'updatedAt'>> & { updatedAt: Date }

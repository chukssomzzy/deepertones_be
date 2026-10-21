import type { faceConsents, faceScanPhotos, faceScans } from './face-scans.table'

export type FaceConsent = typeof faceConsents.$inferSelect
export type FaceScan = typeof faceScans.$inferSelect
export type FaceScanPhoto = typeof faceScanPhotos.$inferSelect

export type FaceScanState = FaceScan['state']
export type FaceScanReason = NonNullable<FaceScan['reason']>
export type FacePhotoPosition = FaceScanPhoto['position']

/** What a new face scan needs: it always starts `analysing`, with no reason, task, result or skin reading, and `updatedAt` equal to `createdAt`. */
export type NewFaceScan = Pick<FaceScan, 'id' | 'userId' | 'profileId' | 'goalAtScan' | 'createdAt'>

export type NewFacePhoto = Pick<FaceScanPhoto, 'faceScanId' | 'userId' | 'position' | 'photoKey' | 'createdAt'>

/** A change to a face scan: any column but its identity, owner, goal and creation time, and when it was made. A field left out is unchanged; null clears it. */
export type FaceScanPatch = Partial<Omit<FaceScan, 'id' | 'userId' | 'profileId' | 'goalAtScan' | 'createdAt' | 'updatedAt'>> & { updatedAt: Date }

export type GiveFaceConsent = { profileId: string; userId: string; version: number; at: Date }

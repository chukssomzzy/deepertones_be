import type { faceShareConsents, faceShares } from './face-shares.table'

export type FaceShareConsent = typeof faceShareConsents.$inferSelect
export type GiveFaceShareConsent = { profileId: string; userId: string; version: number; at: Date }

/** One row of face_shares. The caller supplies the id and the time. */
export type FaceShare = typeof faceShares.$inferSelect
export type NewFaceShare = FaceShare

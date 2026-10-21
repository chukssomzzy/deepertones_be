import type { z } from '@hono/zod-openapi'
import type { FaceConsentGiven, FaceConsentView, FaceScanView } from './face-scans.service'
import type { FaceConsentGivenResponse, FaceConsentResponse, FaceScanResponse } from './face-scans.schemas'

export const toFaceConsentGivenResponse = ({ version, givenAt }: FaceConsentGiven): z.infer<typeof FaceConsentGivenResponse> => ({
  version,
  givenAt: givenAt.toISOString(),
})

export const toFaceConsentResponse = ({ version, givenAt, withdrawnAt, current }: FaceConsentView): z.infer<typeof FaceConsentResponse> => ({
  version,
  givenAt: givenAt.toISOString(),
  withdrawnAt: withdrawnAt?.toISOString() ?? null,
  current,
})

// Every field is named, so a field added to the view is not published by accident.
export const toFaceScanResponse = ({ id, state, reason, goal, createdAt, photos, rescanSuggested }: FaceScanView): z.infer<typeof FaceScanResponse> => ({
  id,
  state,
  reason,
  goal,
  createdAt: createdAt.toISOString(),
  photos: { ...(photos.front ? { front: { url: photos.front.url } } : {}), ...(photos.right ? { right: { url: photos.right.url } } : {}), ...(photos.left ? { left: { url: photos.left.url } } : {}) },
  rescanSuggested,
})

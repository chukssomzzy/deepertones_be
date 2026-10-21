import type { z } from '@hono/zod-openapi'
import type { ResultView } from './face-scans.tables'
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

const toFaceScanResultResponse = ({ seen, nothingStandsOut, skinType, skinAge, sinceDayOne, tablesVersion }: ResultView): NonNullable<z.infer<typeof FaceScanResponse>['result']> => ({
  seen: seen.map(({ concern, region, words, overlay }) => ({ concern, region, words, overlay: overlay ? { url: overlay.url } : null })),
  nothingStandsOut,
  skinType,
  skinAge: skinAge ? { years: skinAge.years, words: skinAge.words } : null,
  sinceDayOne: sinceDayOne
    ? {
        dayOneScanId: sinceDayOne.dayOneScanId,
        dayOneAt: sinceDayOne.dayOneAt.toISOString(),
        concerns: sinceDayOne.concerns.map(({ concern, change, words }) => ({ concern, change, words })),
        skinAge: sinceDayOne.skinAge ? { change: sinceDayOne.skinAge.change, words: sinceDayOne.skinAge.words } : null,
      }
    : null,
  tablesVersion,
})

// Every field is named, so a field added to the view is not published by accident.
export const toFaceScanResponse = ({ id, state, reason, goal, createdAt, photos, rescanSuggested, result }: FaceScanView): z.infer<typeof FaceScanResponse> => ({
  id,
  state,
  reason,
  goal,
  createdAt: createdAt.toISOString(),
  photos: { ...(photos.front ? { front: { url: photos.front.url } } : {}), ...(photos.right ? { right: { url: photos.right.url } } : {}), ...(photos.left ? { left: { url: photos.left.url } } : {}) },
  rescanSuggested,
  result: result ? toFaceScanResultResponse(result) : null,
})

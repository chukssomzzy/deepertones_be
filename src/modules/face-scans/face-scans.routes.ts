import { bodyLimit } from 'hono/body-limit'
import { defineRoute, errorResponses, imageResponse, jsonBody, multipartBody, ok, openapiApp, success } from '../../lib/openapi'
import { rateLimit } from '../../middleware/rate-limit'
import { signedIn } from '../../middleware/signed-in'
import { toProductImage } from '../scans/scans.presenter'
import { toFaceConsentGivenResponse, toFaceConsentResponse, toFaceScanResponse } from './face-scans.presenter'
import { CreateFaceScanBody, FaceConsentGivenResponse, FaceConsentResponse, FacePhotoLinkParams, FaceScanParams, FaceScanResponse, SetFaceConsentBody } from './face-scans.schemas'
import { FACE_SCAN_POLICY } from './face-scans.service'

const bearer = [{ bearerAuth: [] }]

// Room for the multipart framing around the photos. bodyLimit runs before the form is read, so an oversized upload is never buffered.
const FRAMING_BYTES = 1_000_000
const MAX_FACE_SCAN_BODY_BYTES = 3 * FACE_SCAN_POLICY.maxPhotoBytes + FRAMING_BYTES

const setConsent = defineRoute({
  method: 'put',
  path: '/face-consent',
  operationId: 'setFaceConsent',
  tags: ['Face scans'],
  summary: 'Say yes to keeping and analysing face photos',
  description:
    'Guests included. Consent belongs to the active profile. Send `{ version }`, the version of the consent wording the user agreed to: only the current one is accepted, ' +
    'any other is 400 `FACE_CONSENT_VERSION_MISMATCH` with `details.current`. Giving consent again, or after a withdrawal, is 200 and starts it afresh. ' +
    'A face scan is refused (409 `FACE_CONSENT_REQUIRED`) without a current consent.',
  security: bearer,
  // Before the body is validated, so an unsigned caller with a bad or missing body is told 401, not 400.
  middleware: [signedIn()],
  request: { body: jsonBody(SetFaceConsentBody) },
  responses: { 200: success(FaceConsentGivenResponse, 'The consent as given'), ...errorResponses(401) },
})

const getConsent = defineRoute({
  method: 'get',
  path: '/face-consent',
  operationId: 'getFaceConsent',
  tags: ['Face scans'],
  summary: 'The face photo consent this profile gave',
  description: 'A withdrawn consent is still shown, with `withdrawnAt` and `current` false, as is one for an older wording. 404 `FACE_CONSENT_NOT_FOUND` until the profile has given one.',
  security: bearer,
  responses: { 200: success(FaceConsentResponse, 'The consent'), ...errorResponses(401, 404) },
})

const withdrawConsent = defineRoute({
  method: 'delete',
  path: '/face-consent',
  operationId: 'withdrawFaceConsent',
  tags: ['Face scans'],
  summary: 'Take back the face photo consent',
  description: 'Stamps the time and keeps the record; it deletes no photos (delete a face scan to do that). 204 again when already withdrawn, and 204 when there was never any consent.',
  security: bearer,
  responses: { 204: { description: 'The consent is withdrawn' }, ...errorResponses(401) },
})

const createFaceScan = defineRoute({
  method: 'post',
  path: '/',
  operationId: 'createFaceScan',
  tags: ['Face scans'],
  summary: 'Start a face scan from a front photo and optionally two side photos',
  description:
    'Multipart: a `front` part, and optionally `right` and `left`. Every photo must be a JPEG of at most 6,000,000 bytes, with a shorter side of at least 1080 and a longer side of at most 4096 pixels. ' +
    'The checks run in this order and nothing is stored until all pass: 409 `FACE_CONSENT_REQUIRED` (no current consent for this profile), 409 `GOAL_REQUIRED` (pick a goal first), ' +
    '429 `FACE_SCAN_NOT_DUE` (`details.reason` is `already-scanned-for-goal`: the profile\'s latest scan was taken under its current goal), then the photos: ' +
    '400 `UNSUPPORTED_IMAGE`, `IMAGE_TOO_SMALL` or `IMAGE_TOO_LARGE`, and 400 `VALIDATION_FAILED` without a `front`. One bad photo refuses the whole scan. ' +
    'The answer is 202 with the scan `analysing`; if the analysis cannot be queued the scan is `failed` with reason `unavailable` (still 202), and a new scan may be started. ' +
    'Starting a scan costs nothing in the AI spend ledger. A per-address and a per-user limit apply: 429 `RATE_LIMITED` with `Retry-After`.',
  security: bearer,
  // In this order: the address limit counts every caller, signedIn turns away the unsigned before anything is parsed, the user limit needs a user,
  // and bodyLimit comes last because only a signed-in caller is worth reading a body for.
  middleware: [rateLimit('FACE_SCAN_IP_LIMITER', 'ip'), signedIn(), rateLimit('FACE_SCAN_USER_LIMITER', 'user'), bodyLimit({ maxSize: MAX_FACE_SCAN_BODY_BYTES })],
  request: { body: multipartBody(CreateFaceScanBody) },
  responses: { 202: success(FaceScanResponse, 'The scan, analysing'), ...errorResponses(401, 409, 413, 429) },
})

const getFaceScan = defineRoute({
  method: 'get',
  path: '/{id}',
  operationId: 'getFaceScan',
  tags: ['Face scans'],
  summary: 'A face scan and where it has got to',
  description: 'Shows no result yet. Another profile\'s scan, of this account or any other, is 404 `FACE_SCAN_NOT_FOUND`, the same as one that does not exist.',
  security: bearer,
  request: { params: FaceScanParams },
  responses: { 200: success(FaceScanResponse, 'The scan'), ...errorResponses(401, 404) },
})

const deleteFaceScan = defineRoute({
  method: 'delete',
  path: '/{id}',
  operationId: 'deleteFaceScan',
  tags: ['Face scans'],
  summary: 'Delete a face scan and its photos',
  description: 'Deletes the photos from storage, then the scan. Another profile\'s scan is 404 `FACE_SCAN_NOT_FOUND`, the same as one that does not exist or is already deleted. Consent is kept.',
  security: bearer,
  request: { params: FaceScanParams },
  responses: { 204: { description: 'The scan and its photos are deleted' }, ...errorResponses(401, 404) },
})

const getFacePhoto = defineRoute({
  method: 'get',
  path: '/photos/{token}',
  operationId: 'getFaceScanPhoto',
  tags: ['Face scans'],
  summary: 'The photo a link from a face scan opens',
  description:
    'Public: the signed link is the credential, and it works for 5 minutes for whoever holds it. Any Authorization header is ignored. ' +
    'A link that is malformed, tampered with, expired, for a product photo, or to a photo since deleted is 404 `PHOTO_NOT_FOUND`.',
  security: [],
  request: { params: FacePhotoLinkParams },
  responses: { 200: imageResponse('The photo'), ...errorResponses(404) },
})

/** Consent is mounted under /me, beside the other things a profile says about itself. */
export const faceConsentRoutes = openapiApp()
  .openapi(setConsent, async (c) => ok(c, toFaceConsentGivenResponse(await c.var.services.faceScans.giveConsent(c.req.valid('json').version)), 'Consent recorded'))
  .openapi(getConsent, async (c) => ok(c, toFaceConsentResponse(await c.var.services.faceScans.consent()), 'Consent found'))
  .openapi(withdrawConsent, async (c) => {
    await c.var.services.faceScans.withdrawConsent()
    return c.body(null, 204)
  })

export const faceScanRoutes = openapiApp()
  .openapi(createFaceScan, async (c) => {
    const { front, right, left } = c.req.valid('form')
    const scan = await c.var.services.faceScans.create({
      front: await toProductImage(front),
      ...(right ? { right: await toProductImage(right) } : {}),
      ...(left ? { left: await toProductImage(left) } : {}),
    })
    return ok(c, toFaceScanResponse(scan), 'Face scan started', 202)
  })
  .openapi(getFaceScan, async (c) => ok(c, toFaceScanResponse(await c.var.services.faceScans.getFaceScan(c.req.valid('param').id)), 'Face scan found'))
  .openapi(deleteFaceScan, async (c) => {
    await c.var.services.faceScans.deleteFaceScan(c.req.valid('param').id)
    return c.body(null, 204)
  })
  .openapi(getFacePhoto, async (c) => {
    const photo = await c.var.services.faceScans.photoForLink(c.req.valid('param').token)
    return new Response(photo.bytes, { headers: { 'Content-Type': photo.mediaType, 'Cache-Control': 'private, no-store' } })
  })

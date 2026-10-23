import { bodyLimit } from 'hono/body-limit'
import { defineRoute, errorResponses, imageResponse, jsonBody, multipartBody, ok, openapiApp, sseResponse, success } from '../../lib/openapi'
import { rateLimit } from '../../middleware/rate-limit'
import { signedIn } from '../../middleware/signed-in'
import { verifiedUser } from '../../middleware/verified-user'
import { toProductImage } from '../scans/scans.presenter'
import { toFaceConsentGivenResponse, toFaceConsentResponse, toFaceScanResponse } from './face-scans.presenter'
import {
  CreateFaceScanBody,
  FaceConsentGivenResponse,
  FaceConsentResponse,
  FacePhotoLinkParams,
  FaceScanListResponse,
  FaceScanParams,
  FaceScanResponse,
  PerfectCorpWebhookResponse,
  RetakeFaceScanBody,
  SetFaceConsentBody,
} from './face-scans.schemas'
import { FACE_SCAN_POLICY } from './face-scans.service'

const bearer = [{ bearerAuth: [] }]

// A guest may run the scan flow (give consent, start a scan, retake, follow it live: signedIn()); everything that shows or manages what the scan found is for
// verified users (verifiedUser(), 403 VERIFICATION_REQUIRED for a guest). Both are early exits, before any body is parsed or validated, so every route answers the
// same way; the service's requireUser / requireVerified still decide.
const GUEST_OPEN = 'A guest may call this. '
const GUEST_REFUSED = 'Verified users only: a guest gets 403 `VERIFICATION_REQUIRED`. '

// Room for the multipart framing around the photos. bodyLimit runs before the form is read, so an oversized upload is never buffered.
const FRAMING_BYTES = 1_000_000
const MAX_FACE_SCAN_BODY_BYTES = 3 * FACE_SCAN_POLICY.maxPhotoBytes + FRAMING_BYTES
const MAX_RETAKE_BODY_BYTES = FACE_SCAN_POLICY.maxPhotoBytes + FRAMING_BYTES
// The webhook is a small JSON notice. Public, so the cap is the same whatever the sender says.
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024

const setConsent = defineRoute({
  method: 'put',
  path: '/face-consent',
  operationId: 'setFaceConsent',
  tags: ['Face scans'],
  summary: 'Say yes to keeping and analysing face photos',
  description:
    GUEST_OPEN +
    'Consent belongs to the active profile. Send `{ version }`, the version of the consent wording the user agreed to: only the current one is accepted, ' +
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
  description: GUEST_REFUSED + 'A withdrawn consent is still shown, with `withdrawnAt` and `current` false, as is one for an older wording. 404 `FACE_CONSENT_NOT_FOUND` until the profile has given one.',
  security: bearer,
  middleware: [verifiedUser()],
  responses: { 200: success(FaceConsentResponse, 'The consent'), ...errorResponses(401, 403, 404) },
})

const withdrawConsent = defineRoute({
  method: 'delete',
  path: '/face-consent',
  operationId: 'withdrawFaceConsent',
  tags: ['Face scans'],
  summary: 'Take back the face photo consent',
  description:
    GUEST_REFUSED +
    'Stamps the time and keeps the record; it deletes no photos (delete a face scan to do that). 204 again when already withdrawn, and 204 when there was never any consent.',
  security: bearer,
  middleware: [verifiedUser()],
  responses: { 204: { description: 'The consent is withdrawn' }, ...errorResponses(401, 403) },
})

const createFaceScan = defineRoute({
  method: 'post',
  path: '/',
  operationId: 'createFaceScan',
  tags: ['Face scans'],
  summary: 'Start a face scan from a front photo and optionally two side photos',
  description:
    GUEST_OPEN +
    'Multipart: a `front` part, and optionally `right` and `left`. Every photo must be a JPEG of at most 6,000,000 bytes, with a shorter side of at least 1080 and a longer side of at most 4096 pixels. ' +
    'The checks run in this order and nothing is stored until all pass: 409 `FACE_CONSENT_REQUIRED` (no current consent for this profile), 409 `GOAL_REQUIRED` (pick a goal first), ' +
    '429 `FACE_SCAN_NOT_DUE` (`details.reason` is `already-scanned-for-goal`: the profile\'s latest scan was taken under its current goal), then the photos: ' +
    '400 `UNSUPPORTED_IMAGE`, `IMAGE_TOO_SMALL` or `IMAGE_TOO_LARGE`, and 400 `VALIDATION_FAILED` without a `front`. One bad photo refuses the whole scan. ' +
    'The answer is 202 with the scan `analysing`; if the analysis cannot be queued the scan is `failed` with reason `unavailable` (still 202), and a new scan may be started. ' +
    'Starting a scan costs nothing in the AI spend ledger. The answer shows no result; a guest follows the scan with `GET /api/v1/scans/faces/{id}/events` and must verify to read it. ' +
    'A per-address and a per-user limit apply: 429 `RATE_LIMITED` with `Retry-After`.',
  security: bearer,
  // In this order: the address limit counts every caller, signedIn turns away the unsigned before anything is parsed, the user limit needs a user,
  // and bodyLimit comes last because only a signed-in caller is worth reading a body for.
  middleware: [rateLimit('FACE_SCAN_IP_LIMITER', 'ip'), signedIn(), rateLimit('FACE_SCAN_USER_LIMITER', 'user'), bodyLimit({ maxSize: MAX_FACE_SCAN_BODY_BYTES })],
  request: { body: multipartBody(CreateFaceScanBody) },
  responses: { 202: success(FaceScanResponse, 'The scan, analysing'), ...errorResponses(401, 409, 413, 429) },
})

const listFaceScans = defineRoute({
  method: 'get',
  path: '/',
  operationId: 'listFaceScans',
  tags: ['Face scans'],
  summary: 'The profile\'s face scans, latest first',
  description:
    GUEST_REFUSED +
    'The current profile\'s scans, latest first, at most 20, in every state (`analysing`, `needs-retake`, `ready` and `failed`), each as `GET /api/v1/scans/faces/{id}` shows it, ' +
    'with `result` for a ready scan and fresh photo links. A profile with none gets an empty list. It needs no consent and no goal, so it still works after the consent is withdrawn. ' +
    'Another profile\'s scans, of this account or any other, are never listed.',
  security: bearer,
  middleware: [verifiedUser()],
  responses: { 200: success(FaceScanListResponse, 'The scans'), ...errorResponses(401, 403) },
})

const getFaceScan = defineRoute({
  method: 'get',
  path: '/{id}',
  operationId: 'getFaceScan',
  tags: ['Face scans'],
  summary: 'A face scan and where it has got to',
  description:
    GUEST_REFUSED +
    'Shows no result yet. `state` is `analysing`, `needs-retake`, `ready` or `failed`, and `reason` says why a scan needs a retake or failed: follow it live with `GET /api/v1/scans/faces/{id}/events` or poll this. Another profile\'s scan, of this account or any other, is 404 `FACE_SCAN_NOT_FOUND`, the same as one that does not exist.',
  security: bearer,
  middleware: [verifiedUser()],
  request: { params: FaceScanParams },
  responses: { 200: success(FaceScanResponse, 'The scan'), ...errorResponses(401, 403, 404) },
})

const watchFaceScan = defineRoute({
  method: 'get',
  path: '/{id}/events',
  operationId: 'watchFaceScan',
  tags: ['Face scans'],
  summary: 'Follow a face scan live, as server-sent events',
  description:
    GUEST_OPEN +
    'A `text/event-stream`, not the usual envelope (errors before the stream starts still are). Frames carry only `id`, `state` and `reason`, never a result, scores or photo links, so a guest learns the next step ' +
    'and must verify and call `GET /api/v1/scans/faces/{id}` for the result. Frames: `snapshot` first, whose data is `{ id, state, reason }` as the scan now is; then one `face` ' +
    'with the same three fields each time its state changes; then `done` (data `{}`) once the scan is `ready`, `failed` or `needs-retake`, after which the server closes the stream. A scan that is ' +
    'already over gets `snapshot` and `done` at once. A `: ping` comment arrives every 20 seconds while nothing else does. The server closes a stream 10 minutes after it opened; reconnect to carry on, ' +
    'the new `snapshot` is the current state. Send the bearer token as for every other route, which a browser `EventSource` cannot: use `fetch` and read the body. ' +
    'Another profile\'s scan is 404 `FACE_SCAN_NOT_FOUND`, the same as one that does not exist.',
  security: bearer,
  middleware: [signedIn()],
  request: { params: FaceScanParams },
  responses: { 200: sseResponse('The event stream'), ...errorResponses(401, 404) },
})

const retakeFaceScan = defineRoute({
  method: 'post',
  path: '/{id}/retake',
  operationId: 'retakeFaceScan',
  tags: ['Face scans'],
  summary: 'Send a new front photo for a scan that needs a retake',
  description:
    GUEST_OPEN +
    'Multipart with a `front` part only, a JPEG held to the same rules as when the scan was started. For a scan whose `state` is `needs-retake`. The checks run in this order and nothing changes until all pass: ' +
    '404 `FACE_SCAN_NOT_FOUND`, 409 `FACE_CONSENT_REQUIRED`, 409 `FACE_SCAN_NOT_AWAITING_RETAKE` (the scan is in any other state), then the photo: 400 `UNSUPPORTED_IMAGE`, `IMAGE_TOO_SMALL` or `IMAGE_TOO_LARGE`, ' +
    'and 400 `VALIDATION_FAILED` without a `front`. The new photo replaces the old and the scan is `analysing` again with no `reason`: 202 with the scan. If the analysis cannot be queued the scan is `failed` with ' +
    'reason `unavailable` (still 202). A retake is never refused for how many came before it. A per-address and a per-user limit apply: 429 `RATE_LIMITED` with `Retry-After`.',
  security: bearer,
  // The same order and reasons as createFaceScan, and the same limiters: a retake sends a photo to Perfect Corp, which is paid per use.
  middleware: [rateLimit('FACE_SCAN_IP_LIMITER', 'ip'), signedIn(), rateLimit('FACE_SCAN_USER_LIMITER', 'user'), bodyLimit({ maxSize: MAX_RETAKE_BODY_BYTES })],
  request: { params: FaceScanParams, body: multipartBody(RetakeFaceScanBody) },
  responses: { 202: success(FaceScanResponse, 'The scan, analysing again'), ...errorResponses(401, 404, 409, 413, 429) },
})

const deleteFaceScan = defineRoute({
  method: 'delete',
  path: '/{id}',
  operationId: 'deleteFaceScan',
  tags: ['Face scans'],
  summary: 'Delete a face scan and its photos',
  description:
    GUEST_REFUSED +
    'Deletes the photos from storage, then the scan. Another profile\'s scan is 404 `FACE_SCAN_NOT_FOUND`, the same as one that does not exist or is already deleted. Consent is kept.',
  security: bearer,
  middleware: [verifiedUser()],
  request: { params: FaceScanParams },
  responses: { 204: { description: 'The scan and its photos are deleted' }, ...errorResponses(401, 403, 404) },
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

const receivePerfectCorpWebhook = defineRoute({
  method: 'post',
  path: '/perfect-corp',
  operationId: 'receivePerfectCorpWebhook',
  tags: ['Face scans'],
  summary: 'Perfect Corp tells us an analysis task has ended',
  description:
    'Called by Perfect Corp, not by the app. Public: the Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`) on the raw body is the credential, and a delivery that is not correctly signed, ' +
    'is older than 5 minutes, or is not the webhook\'s shape is 401 `WEBHOOK_SIGNATURE_INVALID`. A signed delivery is 200 `{ received: true }` whether or not it matches a scan of this environment (a task from another ' +
    'environment, or of a deleted scan, is ignored). A delivery that matches is queued for the analysis job, which asks Perfect Corp for the result itself; a delivery that cannot be queued is 503 `WEBHOOK_UNAVAILABLE`, so Perfect Corp sends it ' +
    'again, and the same `webhook-id` delivered twice runs the job once. Register this address for each environment in the Perfect Corp console.',
  security: [],
  middleware: [rateLimit('PERFECT_CORP_WEBHOOK_LIMITER', 'ip'), bodyLimit({ maxSize: MAX_WEBHOOK_BODY_BYTES })],
  responses: { 200: success(PerfectCorpWebhookResponse, 'The delivery was accepted'), ...errorResponses(401, 413, 429, 503) },
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
  .openapi(listFaceScans, async (c) => ok(c, { faceScans: (await c.var.services.faceScans.listFaceScans()).map(toFaceScanResponse) }, 'Face scans found'))
  .openapi(getFaceScan, async (c) => ok(c, toFaceScanResponse(await c.var.services.faceScans.getFaceScan(c.req.valid('param').id)), 'Face scan found'))
  .openapi(watchFaceScan, async (c) => c.var.services.faceScans.watch(c.req.valid('param').id))
  .openapi(retakeFaceScan, async (c) => {
    const scan = await c.var.services.faceScans.retake(c.req.valid('param').id, { front: await toProductImage(c.req.valid('form').front) })
    return ok(c, toFaceScanResponse(scan), 'Face scan sent for analysis again', 202)
  })
  .openapi(deleteFaceScan, async (c) => {
    await c.var.services.faceScans.deleteFaceScan(c.req.valid('param').id)
    return c.body(null, 204)
  })
  .openapi(getFacePhoto, async (c) => {
    const photo = await c.var.services.faceScans.photoForLink(c.req.valid('param').token)
    return new Response(photo.bytes, { headers: { 'Content-Type': photo.mediaType, 'Cache-Control': 'private, no-store' } })
  })

/** Mounted at /webhooks: what other services call us on. */
export const webhookRoutes = openapiApp().openapi(receivePerfectCorpWebhook, async (c) => {
  // The raw text, not a parsed body: the signature is over exactly the bytes that arrived.
  await c.var.services.faceScans.receiveWebhook(await c.req.text(), c.req.raw.headers)
  return ok(c, { received: true as const }, 'Webhook received')
})

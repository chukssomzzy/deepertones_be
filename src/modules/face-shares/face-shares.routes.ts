import { defineRoute, errorResponses, imageResponse, jsonBody, ok, openapiApp, success } from '../../lib/openapi'
import { rateLimit } from '../../middleware/rate-limit'
import { signedIn } from '../../middleware/signed-in'
import { FaceShareConsentGivenResponse, FaceShareConsentResponse, SetFaceShareConsentBody, ShareFaceTimelineBody } from './face-shares.schemas'

const bearer = [{ bearerAuth: [] }]

const COVERS = 'The consent covers sharing a before-and-after card of the face photos, made by the server and never stored. '
const SIGNED_UP = 'For a signed-up account: 401 without a session, 403 `SIGNUP_REQUIRED` for a guest. The consent belongs to the active profile. '

const setConsent = defineRoute({
  method: 'put',
  path: '/face-share-consent',
  operationId: 'setFaceShareConsent',
  tags: ['Face shares'],
  summary: 'Say yes to sharing a before-and-after card',
  description:
    COVERS +
    SIGNED_UP +
    'Send `{ version }`, the version of the consent wording the user agreed to: only the current one is accepted, any other is 400 `FACE_SHARE_CONSENT_VERSION_MISMATCH` with `details.current`. ' +
    'It is asked once and remembered. Giving consent again, or after a withdrawal, is 200 and starts it afresh.',
  security: bearer,
  // Before the body is validated, so an unsigned caller with a bad or missing body is told 401, not 400.
  middleware: [signedIn()],
  request: { body: jsonBody(SetFaceShareConsentBody) },
  responses: { 200: success(FaceShareConsentGivenResponse, 'The consent as given'), ...errorResponses(400, 401, 403) },
})

const getConsent = defineRoute({
  method: 'get',
  path: '/face-share-consent',
  operationId: 'getFaceShareConsent',
  tags: ['Face shares'],
  summary: 'The face share consent this profile gave',
  description:
    COVERS +
    SIGNED_UP +
    'A withdrawn consent is still shown, with `withdrawnAt` and `current` false, as is one for an older wording. 404 `FACE_SHARE_CONSENT_NOT_FOUND` until the profile has given one.',
  security: bearer,
  responses: { 200: success(FaceShareConsentResponse, 'The consent'), ...errorResponses(401, 403, 404) },
})

const withdrawConsent = defineRoute({
  method: 'delete',
  path: '/face-share-consent',
  operationId: 'withdrawFaceShareConsent',
  tags: ['Face shares'],
  summary: 'Take back the face share consent',
  description:
    COVERS +
    SIGNED_UP +
    'Stamps the time and keeps the record. 204 again when already withdrawn, and 204 when there was never any consent. After it, the next share asks again.',
  security: bearer,
  responses: { 204: { description: 'The consent is withdrawn' }, ...errorResponses(401, 403) },
})

const shareFaceTimeline = defineRoute({
  method: 'post',
  path: '/face-timeline/share',
  operationId: 'shareFaceTimeline',
  tags: ['Face shares'],
  summary: 'Make the before-and-after card to share',
  description:
    'Makes a 1080 x 1920 card of the user\'s day one face photo and the one in `afterScanId`, labelled "Day 1" and "Day N", and answers it as a PNG with `Cache-Control: private, no-store`. ' +
    'The photos are only resized, never edited, and the card is made for this request and written nowhere by this service. Every goal may share, the fairer goal included. ' +
    'For a signed-up account, checked in this order: 401 without a session, 403 `SIGNUP_REQUIRED` for a guest, 409 `SHARE_CONSENT_REQUIRED` without a current face share consent, ' +
    '409 `NO_DAY_ONE_PHOTO` when the current goal has no day one photo yet, 404 `FACE_SCAN_NOT_FOUND` when `afterScanId` is not a later ready scan of the same goal run with a front photo ' +
    '(an unknown scan, another profile\'s, day one itself and the rest are not told apart), 409 `SHARE_TOO_EARLY` when it is less than 14 days after day one in the user\'s own calendar days (N is the days since day one plus one). ' +
    '503 `SHARE_UNAVAILABLE` when the card cannot be made right now, whatever the cause; nothing is recorded then, and trying again later is fine. A card that is made is recorded as one share. 429 `RATE_LIMITED` past 10 requests a minute per user.',
  security: bearer,
  // Before the body is validated, so an unsigned caller with a bad or missing body is told 401, not 400. Each card spends an Images transformation, so a user's attempts are limited.
  middleware: [signedIn(), rateLimit('FACE_SHARE_USER_LIMITER', 'user')],
  request: { body: jsonBody(ShareFaceTimelineBody) },
  responses: {
    200: imageResponse('The card', ['image/png']),
    ...errorResponses(401, 403, 404, 409, 429, 503),
  },
})

/** Mounted under /me, beside the other things a profile says about itself: its face share consent, and the card it shares. */
export const faceSharesRoutes = openapiApp()
  .openapi(setConsent, async (c) => {
    const { version, givenAt } = await c.var.services.faceShares.giveConsent(c.req.valid('json').version)
    return ok(c, { version, givenAt: givenAt.toISOString() }, 'Consent recorded')
  })
  .openapi(getConsent, async (c) => {
    const { version, givenAt, withdrawnAt, current } = await c.var.services.faceShares.consent()
    return ok(c, { version, givenAt: givenAt.toISOString(), withdrawnAt: withdrawnAt?.toISOString() ?? null, current }, 'Consent found')
  })
  .openapi(withdrawConsent, async (c) => {
    await c.var.services.faceShares.withdrawConsent()
    return c.body(null, 204)
  })
  .openapi(shareFaceTimeline, async (c) => {
    const { bytes, mediaType } = await c.var.services.faceShares.share(c.req.valid('json').afterScanId)
    // Never cached, like the sibling photo routes: the card is a face, made for this request.
    return new Response(bytes, { headers: { 'Content-Type': mediaType, 'Cache-Control': 'private, no-store' } })
  })

import { defineRoute, errorResponses, jsonBody, ok, openapiApp, success } from '../../lib/openapi'
import { signedIn } from '../../middleware/signed-in'
import { FaceShareConsentGivenResponse, FaceShareConsentResponse, SetFaceShareConsentBody } from './face-shares.schemas'

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

/** Mounted under /me, beside the other things a profile says about itself. */
export const faceShareConsentRoutes = openapiApp()
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

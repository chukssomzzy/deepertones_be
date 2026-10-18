import { defineRoute, errorResponses, jsonBody, ok, openapiApp, success } from '../../lib/openapi'
import { rateLimit } from '../../middleware/rate-limit'
import { signedIn } from '../../middleware/signed-in'
import { toSafetyResponse } from './safety.presenter'
import { SafetyResponse, SetSafetyBody } from './safety.schemas'

const bearer = [{ bearerAuth: [] }]

const setSafety = defineRoute({
  method: 'put',
  path: '/safety',
  operationId: 'setSafety',
  tags: ['Onboarding'],
  summary: 'Say what changes what is safe for you',
  description:
    'Guests included. Send `choices` (up to 20 entries from `pregnant`, `breastfeeding`, `reaction`, `prescription`, `none`) and, optionally, `reactionText` and `prescriptionText` (up to 300 characters each once trimmed; every run of whitespace, line breaks and tabs included, is saved as one space). ' +
    '`none` stands alone: with another choice it is 400 `INVALID_SAFETY_ANSWER` (`details.field` `choices`). Words need their own choice ticked, `none` included: otherwise 400 `INVALID_SAFETY_ANSWER` with `details.field` `reactionText` or `prescriptionText`. ' +
    'A blank text counts as left out, and a ticked choice with no words is kept as it is. Words with a link, markup or an invisible character are 400 `INVALID_SAFETY_TEXT` with `details.field`. ' +
    'Every change is kept with its date and the newest is the current answer; nothing carries over from the one before. `excludesPregnancyCaution` is true when `pregnant` or `breastfeeding` is ticked. ' +
    'Words are read in the background, and what they name can be looked up in the product catalog, so each change counts against a per-address and a per-user limit: 429 `RATE_LIMITED` with `Retry-After`.',
  security: bearer,
  // In this order, as for the goal route: the address limit counts every caller, signedIn turns the unsigned away before the body is read,
  // and the user limit comes last.
  middleware: [rateLimit('SAFETY_SET_IP_LIMITER', 'ip'), signedIn(), rateLimit('SAFETY_SET_USER_LIMITER', 'user')],
  request: { body: jsonBody(SetSafetyBody) },
  responses: { 200: success(SafetyResponse, 'The safety answers as they are now'), ...errorResponses(401, 429) },
})

const getSafety = defineRoute({
  method: 'get',
  path: '/safety',
  operationId: 'getSafety',
  tags: ['Onboarding'],
  summary: 'The safety answers this profile gave',
  description: 'The same view PUT answers. 404 `SAFETY_NOT_SET` until the profile has answered, "none of these" included.',
  security: bearer,
  responses: { 200: success(SafetyResponse, 'The current safety answers'), ...errorResponses(401, 404) },
})

export const safetyRoutes = openapiApp()
  .openapi(setSafety, async (c) => ok(c, toSafetyResponse(await c.var.services.safety.set(c.req.valid('json'))), 'Safety answers saved'))
  .openapi(getSafety, async (c) => ok(c, toSafetyResponse(await c.var.services.safety.current()), 'Safety answers'))

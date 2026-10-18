import { defineRoute, errorResponses, jsonBody, ok, openapiApp, success } from '../../lib/openapi'
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
    'Guests included. Send `choices` (one to five of `pregnant`, `breastfeeding`, `reaction`, `prescription`, `none`) and, optionally, `reactionText` and `prescriptionText` (up to 300 characters each once trimmed). ' +
    '`none` stands alone: with another choice it is 400 `INVALID_SAFETY_ANSWER` (`details.field` `choices`). Words need their own choice ticked, `none` included: otherwise 400 `INVALID_SAFETY_ANSWER` with `details.field` `reactionText` or `prescriptionText`. ' +
    'A blank text counts as left out, and a ticked choice with no words is kept as it is. Words with a link, markup or an invisible character are 400 `INVALID_SAFETY_TEXT` with `details.field`. ' +
    'Every change is kept with its date and the newest is the current answer; nothing carries over from the one before. `excludesPregnancyCaution` is true when `pregnant` or `breastfeeding` is ticked.',
  security: bearer,
  request: { body: jsonBody(SetSafetyBody) },
  responses: { 200: success(SafetyResponse, 'The safety answers as they are now'), ...errorResponses(401) },
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

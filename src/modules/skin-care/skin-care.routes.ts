import { defineRoute, errorResponses, jsonBody, ok, openapiApp, success } from '../../lib/openapi'
import { signedIn } from '../../middleware/signed-in'
import { LogSkinBody, LogSkinResponse, PauseParams, SkinLogsResponse, UndoPauseResponse } from './skin-care.schemas'

const bearer = [{ bearerAuth: [] }]

const postSkinLog = defineRoute({
  method: 'post',
  path: '/skin-logs',
  operationId: 'logSkin',
  tags: ['Skin care'],
  summary: 'Log how the skin feels',
  description:
    'For a signed-up account: 401 without a session (before the body is read), 403 `SIGNUP_REQUIRED` for a guest. Allowed before Start and with no routine. Fixed rules decide the outcome (no AI): ' +
    'a red flag (pus or a hot patch, swelling, near the eyes) goes to a professional; stinging, burning or new redness at any level, or any symptom that is hard to ignore, pauses a step; ' +
    'tightness, itching and breakouts get advice; nothing unusual is just logged. A pause outcome is acted on: the newest changed active step is paused (never the sunscreen) and `paused` says which; ' +
    'two steps already paused, or a hard-to-ignore symptom during a step-down with no other active step, goes to a professional instead; with no routine, a routine not started or no step to pause ' +
    'the outcome is `nothing-to-pause`, with a check-in in three days. `response` is the reviewed text with `{step}` filled. A reviewed text the team has not written is 503 `CONTENT_UNAVAILABLE`: the log and any pause are kept. ' +
    '400 `VALIDATION_FAILED` stores nothing: at least one symptom, `nothing-unusual` only alone and with no place, a level for anything else, a note of at most 500 characters.',
  security: bearer,
  middleware: [signedIn()],
  request: { body: jsonBody(LogSkinBody) },
  responses: { 200: success(LogSkinResponse, 'The log, its outcome, the reviewed text and the pause it made'), ...errorResponses(400, 401, 403, 503) },
})

const getSkinLogs = defineRoute({
  method: 'get',
  path: '/skin-logs',
  operationId: 'listSkinLogs',
  tags: ['Skin care'],
  summary: 'The last skin logs, newest first',
  description: 'The caller\'s last 20 logs, newest first, without the note. 401 without a session, 403 `SIGNUP_REQUIRED` for a guest.',
  security: bearer,
  responses: { 200: success(SkinLogsResponse, 'The logs'), ...errorResponses(401, 403) },
})

const undoPause = defineRoute({
  method: 'post',
  path: '/skin-care/pauses/{id}/undo',
  operationId: 'undoPause',
  tags: ['Skin care'],
  summary: 'Undo a pause',
  description:
    'Brings the paused step back at once. Only on the local day of the pause (409 `UNDO_EXPIRED` after it). The log that caused the pause is kept and marked overridden. ' +
    '404 `PAUSE_NOT_FOUND` for another account\'s pause, an id nobody holds, and a pause that is no longer paused (undone already, or replaced when the step\'s product changed). ' +
    '401 without a session, 403 `SIGNUP_REQUIRED` for a guest.',
  security: bearer,
  middleware: [signedIn()],
  request: { params: PauseParams },
  responses: { 200: success(UndoPauseResponse, 'The pause, undone'), ...errorResponses(401, 403, 404, 409) },
})

export const skinCareRoutes = openapiApp()
  .openapi(postSkinLog, async (c) => ok(c, await c.var.services.skinCare.log(c.req.valid('json')), 'Skin log saved'))
  .openapi(getSkinLogs, async (c) => ok(c, { logs: await c.var.services.skinCare.recent() }, 'Skin logs'))
  .openapi(undoPause, async (c) => ok(c, await c.var.services.skinCare.undo(c.req.valid('param').id), 'Pause undone'))

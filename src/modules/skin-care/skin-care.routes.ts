import { defineRoute, documentedOnly, errorResponses, jsonBody, ok, openapiApp, readJsonBody, success } from '../../lib/openapi'
import { signedIn } from '../../middleware/signed-in'
import { CheckInBody, CheckInResponse, CloseHoldBody, CloseHoldResponse, LogSkinBody, LogSkinResponse, PauseParams, SkinLogsResponse, UndoPauseResponse } from './skin-care.schemas'

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
    'A pause made again while its step was being brought back goes back on its ladder (`state` is `bringing-back`), never straight to full strength; any other pause is `undone`. ' +
    '404 `PAUSE_NOT_FOUND` for another account\'s pause, an id nobody holds, and a pause that is no longer paused (undone already, or replaced when the step\'s product changed). ' +
    '401 without a session, 403 `SIGNUP_REQUIRED` for a guest.',
  security: bearer,
  middleware: [signedIn()],
  request: { params: PauseParams },
  responses: { 200: success(UndoPauseResponse, 'The pause, undone'), ...errorResponses(401, 403, 404, 409) },
})

const checkIn = defineRoute({
  method: 'post',
  path: '/skin-care/pauses/{id}/check-in',
  operationId: 'answerCheckIn',
  tags: ['Skin care'],
  summary: 'Say how a paused step feels',
  description:
    'The answer to the check-in on a pause, from its check day on (409 `CHECK_IN_NOT_DUE` before it). `calmer` on a step brings it back on a gentle ladder: the pause becomes `bringing-back`, the routine shows the step on ' +
    'its first rung and an inbox row says so; on the check-in with no step it ends. `same` keeps the step paused and asks again three days from today, and the third `same` in a row goes to a professional. ' +
    '`worse` goes to a professional. While an escalation hold is open, `calmer` and `same` on a step the hold keeps out are 409 `HOLD_OPEN` (503 `ROUTINE_UNAVAILABLE` if the routine cannot be read, so it cannot be told); close the hold first. A professional result sets the pause to `escalated`: it is never asked again and the routine keeps the step out. `response` is the reviewed text with `{step}` filled, or the ' +
    'reviewed professional text. A reviewed text or ladder the team has not written is 503 `CONTENT_UNAVAILABLE`, and the pause is as it was. 400 `VALIDATION_FAILED` for any other answer. ' +
    '404 `PAUSE_NOT_FOUND` for another account\'s pause, an id nobody holds, and a pause that is not `paused`. 401 without a session and 403 `SIGNUP_REQUIRED` for a guest, both before the body is read.',
  security: bearer,
  middleware: [signedIn()],
  request: { params: PauseParams, body: jsonBody(CheckInBody) },
  responses: { 200: success(CheckInResponse, 'The outcome, the reviewed text and the pause as it is now'), ...errorResponses(400, 401, 403, 404, 409, 503) },
})

// The check-in is documented with its body but served from a copy without it, so an empty or malformed body is VALIDATION_FAILED (@hono/zod-openapi would answer HTTP_400).
const checkInServed = { ...checkIn, request: { params: PauseParams }, hide: true }

const closeHold = defineRoute({
  method: 'post',
  path: '/skin-care/hold/close',
  operationId: 'closeEscalationHold',
  tags: ['Skin care'],
  summary: 'Close the escalation hold',
  description:
    'A professional result (a red-flag log, a harm log with two steps already paused, a worse or unchanged check-in) keeps the steps with an active ingredient out of the routine as `held`, until the person ' +
    'closes the hold: `seen` (they saw a professional) or `settled` (the skin has settled). Each held step is then due a check-in the same day: an escalated pause is `paused` again (its "about the same" count cleared), ' +
    'an open pause is due today, a step being brought back is paused again (its ladder is kept, and Calmer starts it again at the first rung), and a held step with no pause gets one (it cannot be undone). `checkInsDue` lists what is due today. ' +
    '503 `ROUTINE_UNAVAILABLE` when the routine cannot be read (which steps are held is then unknown): the hold stays open and the request can be repeated. 404 `HOLD_NOT_FOUND` for an account with no open hold, and for the second of two closes. 400 `VALIDATION_FAILED` for any other body. 401 without a session and 403 `SIGNUP_REQUIRED` for a guest, both before the body is read.',
  security: bearer,
  middleware: [signedIn()],
  request: { body: jsonBody(CloseHoldBody) },
  responses: { 200: success(CloseHoldResponse, 'The hold, closed, and the check-ins due today'), ...errorResponses(400, 401, 403, 404, 503) },
})

// Documented with its body, served from a copy without it, as the check-in is.
const closeHoldServed = { ...closeHold, request: {}, hide: true }

export const skinCareRoutes = openapiApp()
  .openapi(postSkinLog, async (c) => ok(c, await c.var.services.skinCare.log(c.req.valid('json')), 'Skin log saved'))
  .openapi(getSkinLogs, async (c) => ok(c, { logs: await c.var.services.skinCare.recent() }, 'Skin logs'))
  .openapi(undoPause, async (c) => ok(c, await c.var.services.skinCare.undo(c.req.valid('param').id), 'Pause undone'))
  .openapi(checkInServed, async (c) => {
    // The account is checked before the body is read, so a guest with a bad body is 403, not 400.
    c.var.services.skinCare.requireSignedUp()
    const { answer } = readJsonBody(await c.req.text(), CheckInBody)
    return ok(c, await c.var.services.skinCare.answerCheckIn(c.req.valid('param').id, answer), 'Check-in answered')
  })
  .openapi(closeHoldServed, async (c) => {
    c.var.services.skinCare.requireSignedUp()
    const { how } = readJsonBody(await c.req.text(), CloseHoldBody)
    return ok(c, await c.var.services.skinCare.closeHold(how), 'Hold closed')
  })

skinCareRoutes.openAPIRegistry.registerPath(documentedOnly(checkIn))
skinCareRoutes.openAPIRegistry.registerPath(documentedOnly(closeHold))

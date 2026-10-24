import { defineRoute, errorResponses, jsonBody, ok, openapiApp, success } from '../../lib/openapi'
import { rateLimit } from '../../middleware/rate-limit'
import { signedIn } from '../../middleware/signed-in'
import { toGoalResponse, toOnboardingResponse, toSwitchPreviewResponse } from './goals.presenter'
import { GoalResponse, OnboardingResponse, SetGoalBody, SwitchPreviewQuery, SwitchPreviewResponse } from './goals.schemas'

const bearer = [{ bearerAuth: [] }]

const setGoal = defineRoute({
  method: 'put',
  path: '/goal',
  operationId: 'setGoal',
  tags: ['Onboarding'],
  summary: 'Say what you want your skin to look like',
  description:
    'Guests included. Send `{ goal }` (a chip) or `{ text }` (the user\'s own words), not both. A chip answers with the honest answer for that goal. ' +
    'Typed words are read by a small model and sorted into one of the six goals, and the answer for that goal comes back. Words that ask to be lighter, fairer or whiter are sorted as `brighter` with `wantsLighter` true, and the answer adds a plain note on what a routine cannot change. ' +
    'Words the model finds no goal in, or that it cannot read right now, are saved with no goal and no answer (still 200), so the app shows the chips; a chip picked next keeps those words. ' +
    'Every change is kept with its date, and the newest is the current goal. Words with a link, markup or an invisible character are 400 `INVALID_GOAL_TEXT`, and no model is called for them. ' +
    'Each change counts against a per-address and a per-user limit, chips included: 429 `RATE_LIMITED` with `Retry-After`.',
  security: bearer,
  // In this order, as for the scan routes: the address limit counts every caller, signedIn turns the unsigned away before the body is read,
  // and the user limit comes last.
  middleware: [rateLimit('GOAL_SET_IP_LIMITER', 'ip'), signedIn(), rateLimit('GOAL_SET_USER_LIMITER', 'user')],
  request: { body: jsonBody(SetGoalBody) },
  responses: { 200: success(GoalResponse, 'The goal as it is now'), ...errorResponses(401, 429) },
})

const getGoal = defineRoute({
  method: 'get',
  path: '/goal',
  operationId: 'getGoal',
  tags: ['Onboarding'],
  summary: 'The goal this profile set',
  description: 'The same view PUT answers. 404 `GOAL_NOT_SET` until the profile has saved a goal or some words.',
  security: bearer,
  responses: { 200: success(GoalResponse, 'The current goal'), ...errorResponses(401, 404) },
})

const getOnboarding = defineRoute({
  method: 'get',
  path: '/onboarding',
  operationId: 'getOnboarding',
  tags: ['Onboarding'],
  summary: 'Which first-run step comes next',
  description: '`next` is `goal` until a goal is picked (typed words alone do not count), then `safety` until the safety question is answered ("none of these" is an answer), then `shelf`. ' +
    '`safety` is the current answers whatever the step, or null.',
  security: bearer,
  responses: { 200: success(OnboardingResponse, 'Where the profile is in the first run'), ...errorResponses(401) },
})

const getSwitchPreview = defineRoute({
  method: 'get',
  path: '/goal/switch-preview',
  operationId: 'getSwitchPreview',
  tags: ['Onboarding'],
  summary: 'What switching to another goal would do',
  description:
    'Guests included. `outcome` is `resume` when the goal was left no more than 90 days ago and its chase would continue, with `dayOneAt` (its first ready scan, or null) and `resumeUntil` (90 days after it was left); ' +
    'otherwise `fresh`, with both null. A profile with no goal yet starts every goal fresh. Reads only: no goal is saved and no scan is made. The goal the profile is already on is 400 `GOAL_ALREADY_CURRENT`.',
  security: bearer,
  request: { query: SwitchPreviewQuery },
  responses: { 200: success(SwitchPreviewResponse, 'What switching would do'), ...errorResponses(400, 401) },
})

export const goalsRoutes = openapiApp()
  .openapi(setGoal, async (c) => ok(c, toGoalResponse(await c.var.services.goals.set(c.req.valid('json'))), 'Goal saved'))
  .openapi(getGoal, async (c) => ok(c, toGoalResponse(await c.var.services.goals.current()), 'Goal'))
  .openapi(getOnboarding, async (c) => ok(c, toOnboardingResponse(await c.var.services.goals.onboarding()), 'Onboarding'))

  .openapi(getSwitchPreview, async (c) => ok(c, toSwitchPreviewResponse(await c.var.services.faceScans.switchPreview(c.req.valid('query').goal)), 'Switch preview'))

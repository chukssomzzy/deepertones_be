import { defineRoute, errorResponses, jsonBody, ok, openapiApp, success } from '../../lib/openapi'
import { toGoalResponse, toOnboardingResponse } from './goals.presenter'
import { GoalResponse, OnboardingResponse, SetGoalBody } from './goals.schemas'

const bearer = [{ bearerAuth: [] }]

const setGoal = defineRoute({
  method: 'put',
  path: '/goal',
  operationId: 'setGoal',
  tags: ['Onboarding'],
  summary: 'Say what you want your skin to look like',
  description:
    'Guests included. Send `{ goal }` (a chip) or `{ text }` (the user\'s own words), not both. A chip answers with the honest answer for that goal. ' +
    'Typed words are saved with no goal and no answer for now; a chip picked next keeps those words. Every change is kept with its date, and the newest is the current goal. ' +
    'Words with a link, markup or an invisible character are 400 `INVALID_GOAL_TEXT`.',
  security: bearer,
  request: { body: jsonBody(SetGoalBody) },
  responses: { 200: success(GoalResponse, 'The goal as it is now'), ...errorResponses(401) },
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
  description: '`next` is `goal` until a goal is picked (typed words alone do not count), then `safety`.',
  security: bearer,
  responses: { 200: success(OnboardingResponse, 'Where the profile is in the first run'), ...errorResponses(401) },
})

export const goalsRoutes = openapiApp()
  .openapi(setGoal, async (c) => ok(c, toGoalResponse(await c.var.services.goals.set(c.req.valid('json'))), 'Goal saved'))
  .openapi(getGoal, async (c) => ok(c, toGoalResponse(await c.var.services.goals.current()), 'Goal'))
  .openapi(getOnboarding, async (c) => ok(c, toOnboardingResponse(await c.var.services.goals.onboarding()), 'Onboarding'))

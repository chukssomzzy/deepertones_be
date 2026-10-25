import { defineRoute, errorResponses, ok, openapiApp, success } from '../../lib/openapi'
import { toShelfVerdictResponse } from './verdicts.presenter'
import { ShelfVerdictResponse } from './verdicts.schemas'

const bearer = [{ bearerAuth: [] }]

const getVerdict = defineRoute({
  method: 'get',
  path: '/verdict',
  operationId: 'getShelfVerdict',
  tags: ['Verdict'],
  summary: 'What to do with each product on the shelf',
  description:
    'Guests included. For every skin-care product on the profile\'s shelf: keep it, reduce it, stop it by a step-down, or drop it, with the reason in words for the user. ' +
    'The verdict is built in the background, never in this request. `{ status: \'pending\' }` means a build is on its way (this ask queues it when none is fresh): ask again shortly. ' +
    'A verdict built before the shelf, the safety answers, the goal, the face scan or the rules changed is never served as if it were current; the answer is `pending` until the new one is built. ' +
    '`status: \'ready\'` carries `fit` (`not-ready` when the goal-fit check failed: those products are shown as `undecided` and kept for now, and it is tried again), `products` and `tapers`: ' +
    'the step-downs that the `stop` verdicts name by `taperCode`, each once. ' +
    '503 `VERDICT_UNAVAILABLE` while the steroid or the lightening-agent step-down is not approved yet (checked first, even for a profile with no goal). 409 `GOAL_REQUIRED` for a profile with no goal.',
  security: bearer,
  responses: { 200: success(ShelfVerdictResponse, 'The verdict, or pending'), ...errorResponses(401, 409, 503) },
})

export const verdictsRoutes = openapiApp().openapi(getVerdict, async (c) => ok(c, toShelfVerdictResponse(await c.var.services.verdicts.current()), 'Shelf verdict'))

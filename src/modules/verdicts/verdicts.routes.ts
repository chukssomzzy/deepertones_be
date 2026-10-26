import { defineRoute, errorResponses, ok, openapiApp, sseResponse, success } from '../../lib/openapi'
import { signedIn } from '../../middleware/signed-in'
import { toShelfVerdictResponse } from './verdicts.view'
import { ShelfVerdictResponse } from './verdicts.schemas'

const bearer = [{ bearerAuth: [] }]

const getVerdict = defineRoute({
  method: 'get',
  path: '/verdict',
  operationId: 'getShelfVerdict',
  tags: ['Verdict'],
  summary: 'What to do with each product on the shelf',
  description:
    'Guests included, but a guest is never given the full verdict. For every skin-care product on the profile\'s shelf, a verified user is told: keep it, reduce it, stop it by a step-down, or drop it, with the reason in words for the user. ' +
    'The verdict is built in the background, never in this request. `{ status: \'pending\' }` means a build is on its way (this ask queues it when none is fresh): ask again shortly. ' +
    'A verdict built before the shelf, the safety answers, the goal, the face scan or the rules changed is never served as if it were current; the answer is `pending` until the new one is built. ' +
    '`status: \'ready\'` carries `locked` and `fit` (`not-ready` when the goal-fit check failed: those products are counted as `undecided` and kept for now, and it is tried again). ' +
    'A verified user\'s ready verdict has `locked: false`, `products` and `tapers`: the step-downs that the `stop` verdicts name by `taperCode`, each once. ' +
    'A guest\'s has `locked: true` and a preview only: `total` (how many products), `counts` (how many under each heading, 0 where none) and `escalates` (how many to see a professional about), and no product, reason or step-down; ' +
    'it is the same saved verdict, so signing up shows the full one at once with no new build. ' +
    '503 `VERDICT_UNAVAILABLE` while the steroid or the lightening-agent step-down is not approved yet (checked first, even for a profile with no goal). 409 `GOAL_REQUIRED` for a profile with no goal.',
  security: bearer,
  responses: { 200: success(ShelfVerdictResponse, 'The full verdict for a verified user, the locked preview for a guest, or pending'), ...errorResponses(401, 409, 503) },
})

const watchVerdict = defineRoute({
  method: 'get',
  path: '/verdict/events',
  operationId: 'watchShelfVerdict',
  tags: ['Verdict'],
  summary: 'Follow the shelf verdict live, as server-sent events',
  description:
    'Guests included, who are only ever sent the locked preview. A `text/event-stream`, not the usual envelope (errors before the stream starts still are). The gates and the build are those of `GET /api/v1/me/verdict`: ' +
    '503 `VERDICT_UNAVAILABLE` while the steroid or the lightening-agent step-down is not approved yet (checked first), then 409 `GOAL_REQUIRED` for a profile with no goal; ' +
    'otherwise this ask queues the build when none is fresh. Frames: `snapshot` first, whose data is the body `GET /api/v1/me/verdict` answers now for the caller (`{ status: \'pending\' }`, the full verdict for a verified user or the locked preview for a guest); ' +
    'then one `verdict` each time a build saves, whose data is the ready verdict in that same shape (a guest never receives a product on it); then `done` (data `{}`) after a `verdict` whose `fit` is `ready`, or whose goal-fit check has had its retry (nothing more is coming soon), after which the server closes the stream. ' +
    'A verdict whose `fit` is `not-ready` while a try is still to come is not followed by `done`: the check is tried again and its `verdict` arrives on the open stream. ' +
    'A `verdict` of `{ status: \'pending\' }` (no `done`) means the shelf or answers changed while the verdict was being built: the new one is on its way on the same stream. A verdict that is already current and ' +
    'finished gets `snapshot` and `done` at once. A `: ping` comment arrives every 20 seconds while nothing else does. The server closes a stream 10 minutes after it opened; reconnect to carry on, ' +
    'the new `snapshot` is the current state. Send the bearer token as for every other route, which a browser `EventSource` cannot: use `fetch` and read the body.',
  security: bearer,
  middleware: [signedIn()],
  responses: { 200: sseResponse('The event stream'), ...errorResponses(401, 409, 503) },
})

export const verdictsRoutes = openapiApp()
  .openapi(getVerdict, async (c) => ok(c, toShelfVerdictResponse(await c.var.services.verdicts.current()), 'Shelf verdict'))
  .openapi(watchVerdict, async (c) => c.var.services.verdicts.watch())

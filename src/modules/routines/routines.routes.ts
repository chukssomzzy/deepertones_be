import { defineRoute, errorResponses, ok, openapiApp, sseResponse, success } from '../../lib/openapi'
import { FALLBACK_IP, rateLimit } from '../../middleware/rate-limit'
import { signedIn } from '../../middleware/signed-in'
import { LookForResponse, RoutineResponse, StepParams } from './routines.schemas'

const bearer = [{ bearerAuth: [] }]

// Every route here is for a signed-up account, gated in this order: 401, 403 `SIGNUP_REQUIRED` (a guest), 409 `GOAL_REQUIRED`, 503 `VERDICT_UNAVAILABLE`.
const GATES =
  'For a signed-up account only: 401 without a session, 403 `SIGNUP_REQUIRED` for a guest, 409 `GOAL_REQUIRED` for a profile with no goal, then 503 `VERDICT_UNAVAILABLE` while the ' +
  'steroid or the lightening-agent step-down is not approved yet (the routine is built from the verdict). Note the order against the verdict\'s own, which answers 503 before 409. '

const getRoutine = defineRoute({
  method: 'get',
  path: '/routine',
  operationId: 'getRoutine',
  tags: ['Routine'],
  summary: 'The routine as Morning and Evening lists, what is not in it, and a dated step-down for each product being stopped',
  description:
    GATES +
    'The routine is built in the background, never in this request. `{ status: \'pending\' }`: nothing to show yet (a build is on its way, which this ask requests when none is fresh), or the routine ' +
    'no longer fits the safety answers and is being rebuilt. `ready` carries the routine in force, as `morning` and `evening` lists of entries (a step used morning and evening is in both) and `notInRoutine`; `updating` is the same body while a newer build is under way. An entry\'s `product` is `own` (a ' +
    'product on the shelf), `recommended` (from the catalog, with its price range and where it is sold in the country the profile shops in) or `none` ("use what you have"). A recommended product ' +
    'the shopping country does not sell, or that has been retired, stays on the screen with `soldInCurrentCountry: false`. `changed` marks the steps that differ from the routine the user was last ' +
    'shown; reading the routine marks it shown. Step-down dates (`fromDate`, `toDate`, UTC days) appear once the user has started the routine.',
  security: bearer,
  responses: { 200: success(RoutineResponse, 'The routine, or pending'), ...errorResponses(401, 403, 409, 503) },
})

const watchRoutine = defineRoute({
  method: 'get',
  path: '/routine/events',
  operationId: 'watchRoutine',
  tags: ['Routine'],
  summary: 'Follow the routine live, as server-sent events',
  description:
    GATES +
    'A `text/event-stream`, not the usual envelope (errors before the stream starts still are). Frames: `snapshot` first, whose data is the body `GET /api/v1/me/routine` answers now; ' +
    'then one `routine` each time a build starts or finishes, or "I got it" is recorded, whose data is the routine in that same shape (`updating` while a build is under way); then `done` ' +
    '(data `{}`) after a `routine` that is `ready`, after which the server closes the stream. A routine that is already ready gets `snapshot` and `done` at once. `pending` and `updating` leave the ' +
    'stream open for the build\'s `routine`. A `: ping` comment arrives every 20 seconds while nothing else does. The server closes a stream 10 minutes after it opened; reconnect to carry on. ' +
    'Send the bearer token as for every other route, which a browser `EventSource` cannot: use `fetch` and read the body.',
  security: bearer,
  middleware: [signedIn()],
  responses: { 200: sseResponse('The event stream'), ...errorResponses(401, 403, 409, 503) },
})

const startRoutine = defineRoute({
  method: 'post',
  path: '/routine/start',
  operationId: 'startRoutine',
  tags: ['Routine'],
  summary: 'Start the routine: tomorrow is day 1',
  description:
    GATES +
    'No body. Dates the routine, and the step-downs in it, from tomorrow (the next UTC day): the first step is the morning after the tap. Starting again changes nothing and answers the same body. 409 `ROUTINE_NOT_READY` before there is a routine, and while a safety change hides it (`GET` answers pending): a routine you cannot see is not started.',
  security: bearer,
  responses: { 200: success(RoutineResponse, 'The routine, started'), ...errorResponses(401, 403, 409, 503) },
})

const gotIt = defineRoute({
  method: 'post',
  path: '/routine/steps/{step}/got-it',
  operationId: 'markRoutineStepGot',
  tags: ['Routine'],
  summary: 'The user has the recommended product for this step',
  description:
    GATES +
    'No body. Puts the step\'s recommended product on the shelf, as adding it from search does (it counts toward the same limits: 429 `RATE_LIMITED`, `SCAN_DAILY_LIMIT`), and answers the routine with that product no longer ' +
    '`notYetGot`. No writer is called. Tapping again for a step already marked got changes nothing (no second shelf add, no new version) and answers the routine. 409 `ROUTINE_NOT_READY` before there ' +
    'is a routine, and while a safety change hides it; 409 `STEP_NOT_RECOMMENDED` for a step that holds a shelf product or nothing, or a product sold nowhere now.',
  security: bearer,
  // The shelf add's limits: it adds a product to the shelf. The address limit counts every caller, signedIn turns away the unsigned, the user limit needs a user.
  middleware: [rateLimit('SHELF_ADD_IP_LIMITER', 'ip'), signedIn(), rateLimit('SHELF_ADD_USER_LIMITER', 'user')],
  request: { params: StepParams },
  responses: { 200: success(RoutineResponse, 'The routine, with that product marked got'), ...errorResponses(401, 403, 409, 429, 503) },
})

const findSoldHere = defineRoute({
  method: 'post',
  path: '/routine/steps/{step}/find-sold-here',
  operationId: 'findRoutineProductSoldHere',
  tags: ['Routine'],
  summary: 'Ask for another product for a step whose product is not sold in this country',
  description:
    GATES +
    'No body. For a step whose recommended product is not sold in the shopping country (or has been retired). Queues a build that picks the step again without that product and answers 202 with the ' +
    'routine in force as `updating`; the new routine arrives as `ready` on `GET /api/v1/me/routine` or its `/events`. Asking again while that build is waiting answers 409 `BUILD_IN_PROGRESS`, as no second build is queued. ' +
    '409 `ROUTINE_NOT_READY` before there is a routine; 409 `STEP_NOT_RECOMMENDED` for a step that holds a shelf product or nothing, or a product sold here already; 409 `BUILD_IN_PROGRESS` when ' +
    'nothing could be queued because the routine is being updated right now (including the same step asked a second time): nothing was lost, try again in a moment.',
  security: bearer,
  request: { params: StepParams },
  responses: { 202: success(RoutineResponse, 'The routine in force, updating'), ...errorResponses(401, 403, 409, 503) },
})

const lookFor = defineRoute({
  method: 'get',
  path: '/routine/steps/{step}/look-for',
  operationId: 'getRoutineStepLookFor',
  tags: ['Routine'],
  summary: 'What to look for in a step\'s product, and the reviewed products that suit the person',
  description:
    GATES +
    'Reads only: it asks for no build. Then 409 `ROUTINE_NOT_READY` before there is a routine to show (a safety change that hides it included), 409 `STEP_IS_YOURS` when the routine uses the ' +
    'person\'s own product for the step (nothing is pushed to buy a replacement), and 503 `GUIDE_UNAVAILABLE` while no approved guide covers the step. It answers for a recommended step and for a ' +
    '"use what you have" step. `guide.lookFor` is the guide\'s pregnancy-safe text for a person who is pregnant or breastfeeding when the guide has one. `products` are the reviewed ' +
    'products for the step in the shopping country that pass the same safety and skin rules as the routine, the routine\'s pick first (`inYourRoutine`), then the cheapest, at most ten; `typicalPrice` ' +
    'and `commonlySoldAt` are over all of them. No product is sold here and nothing is ranked for money.',
  security: bearer,
  request: { params: StepParams },
  responses: { 200: success(LookForResponse, 'What to look for'), ...errorResponses(400, 401, 403, 409, 503) },
})

export const routinesRoutes = openapiApp()
  .openapi(getRoutine, async (c) => ok(c, await c.var.services.routineViewer.current(), 'Routine'))
  .openapi(watchRoutine, async (c) => c.var.services.routineViewer.watch())
  .openapi(startRoutine, async (c) => ok(c, await c.var.services.routineViewer.start(), 'Routine started'))
  .openapi(gotIt, async (c) => ok(c, await c.var.services.routineViewer.gotIt(c.req.valid('param').step, c.req.header('cf-connecting-ip') ?? FALLBACK_IP), 'Product marked as got'))
  .openapi(findSoldHere, async (c) => ok(c, await c.var.services.routineViewer.findSoldHere(c.req.valid('param').step), 'Looking for another product', 202))
  .openapi(lookFor, async (c) => ok(c, await c.var.services.routineViewer.lookFor(c.req.valid('param').step), 'What to look for'))

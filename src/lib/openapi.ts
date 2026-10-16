import { createRoute, OpenAPIHono, type RouteConfig, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { type ErrorBody, ValidationError } from './errors'
import type { AppEnv } from './factory'

/**
 * Building blocks for documented routes. Every route module is an openapiApp() whose
 * routes are declared with defineRoute(), so the OpenAPI spec (/openapi.json, /docs and
 * docs/openapi.json) is generated from the same objects that validate requests, and the
 * compiler rejects a handler that returns a status or body its route does not declare.
 *
 *   const getTrack = defineRoute({
 *     method: 'get', path: '/{id}', operationId: 'getTrack', tags: ['Tracks'],
 *     request: { params: TrackParams },
 *     responses: { 200: success(TrackResponse, 'The track'), ...errorResponses(404) },
 *   })
 *   export const trackRoutes = openapiApp().openapi(getTrack, async (c) => ok(c, track, 'Track found'))
 */

/** The body errorHandler renders for every error. Registered once as a component. */
export const ErrorResponse = z
  .object({
    success: z.literal(false).openapi({ description: 'Always false for an error.' }),
    status: z.number().int().openapi({ description: 'The HTTP status code, repeated for clients that only keep the body.' }),
    message: z.string().openapi({ description: 'Human-readable; may change. Branch on `error.code`.' }),
    error: z.object({
      code: z.string().openapi({ description: 'Stable, machine-readable code.', example: 'NOT_FOUND' }),
      details: z.unknown().optional().openapi({
        description: 'Extra context. For VALIDATION_FAILED: a list of `{ path, message }`, one per invalid field.',
      }),
      requestId: z.string().openapi({ description: 'Also sent as the X-Request-Id header. Quote it when reporting a bug.' }),
    }),
  })
  .openapi('ErrorResponse') satisfies z.ZodType<ErrorBody>

/**
 * The statuses errorHandler can produce: statusByKind in errors.ts, plus 413 (bodyLimit) and 415
 * (@hono/zod-openapi), which are thrown as HTTPExceptions.
 */
const errorDescriptions = {
  400: 'Invalid input (code VALIDATION_FAILED) or a broken business rule',
  401: 'Sign-in required',
  403: 'Signed in, but not allowed to do this',
  404: 'Not found',
  409: 'Conflicts with the current state',
  413: 'Request body too large',
  415: 'The Content-Type of the body is not supported by this route',
  429: 'Too many requests; wait for the Retry-After header (seconds) when present',
  500: 'Unexpected server error',
  503: 'A dependency is down; retry later',
} as const

type ErrorStatus = keyof typeof errorDescriptions

/** A JSON response for errors and other non-enveloped bodies. */
const json = <Schema extends z.ZodType>(schema: Schema, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})

/**
 * A success response: `200: success(TrackResponse, 'The track')`. Documents the envelope around
 * `schema`, and because the handler's return type is checked against it, a handler cannot
 * return bare data; it has to go through ok().
 */
export const success = <Schema extends z.ZodType>(schema: Schema, description: string) =>
  json(
    z.object({
      success: z.literal(true).openapi({ description: 'Always true for a 2xx response.' }),
      status: z.number().int().openapi({ description: 'The HTTP status code, repeated for clients that only keep the body.' }),
      message: z.string().openapi({ description: 'Human-readable; may change.' }),
      data: schema,
    }),
    description,
  )

type OkStatus = 200 | 201 | 202

/**
 * Sends the success envelope. One argument sets both the HTTP status and the body's `status`,
 * so they cannot disagree. 204 is not enveloped (it has no body): return `c.body(null, 204)`.
 */
export const ok = <Data, Status extends OkStatus = 200>(
  c: Context<AppEnv>,
  data: Data,
  message: string,
  status: Status = 200 as Status,
) => c.json({ success: true as const, status, message, data }, status)

/**
 * A required JSON request body: `request: { body: jsonBody(CreateTrackBody) }`.
 * `required: true` matters: without it, a request with no JSON Content-Type skips validation.
 */
export const jsonBody = <Schema extends z.ZodType>(schema: Schema) => ({
  required: true,
  content: { 'application/json': { schema } },
})

/**
 * A required multipart/form-data body: `request: { body: multipartBody(CreateScanBody) }`. Read it with
 * `c.req.valid('form')`. `required: true` for the same reason as jsonBody. A file field is
 * `z.instanceof(File).openapi({ type: 'string', format: 'binary' })`: the generator cannot describe a File
 * on its own. Pair it with `bodyLimit` in the route's `middleware`, which runs before the form is read.
 */
export const multipartBody = <Schema extends z.ZodType>(schema: Schema) => ({
  required: true,
  content: { 'multipart/form-data': { schema } },
})

const binary = () => z.string().openapi({ type: 'string', format: 'binary' })

/**
 * A 200 that is an image, not the envelope: `200: imageResponse('The photo')`. The handler sends the bytes with
 * its own Content-Type and Cache-Control. Any status with a non-JSON body makes the compiler accept any return from
 * that route's handler, so the integration tests are what checks it.
 */
export const imageResponse = (description: string) => ({
  description,
  content: { 'image/jpeg': { schema: binary() }, 'image/webp': { schema: binary() } },
})

/** A 200 that is a server-sent event stream, not the envelope: `200: sseResponse('Progress, as it happens')`. Same compiler caveat as imageResponse. */
export const sseResponse = (description: string) => ({
  description,
  content: { 'text/event-stream': { schema: z.string().openapi({ description: 'Frames of `event:` and `data:` lines.' }) } },
})

type ErrorResponses<S extends ErrorStatus> = { [K in S]: ReturnType<typeof json<typeof ErrorResponse>> }

/** The error statuses a route can produce, besides the ones defineRoute adds: `...errorResponses(401, 404)`. */
export const errorResponses = <S extends ErrorStatus>(...statuses: S[]) =>
  Object.fromEntries(
    statuses.map((status) => [status, json(ErrorResponse, errorDescriptions[status])]),
  ) as ErrorResponses<S>

/** What every route must say about itself. operationId names the method in generated clients. */
type DocumentedRoute = RouteConfig & { operationId: string; tags: [string, ...string[]] }

/** 500 on every route, 400 on any route that validates input, 415 on any route that takes a body (JSON or multipart). */
type DefaultErrors<R extends RouteConfig> = R extends { request: { body: object } }
  ? ErrorResponses<400 | 415 | 500>
  : R extends { request: object }
    ? ErrorResponses<400 | 500>
    : ErrorResponses<500>

/** createRoute, plus the error responses every route has, so no route can forget them. */
export const defineRoute = <const R extends DocumentedRoute>(route: R) =>
  createRoute({
    ...route,
    responses: {
      ...errorResponses(500),
      ...(route.request ? errorResponses(400) : {}),
      ...(route.request?.body ? errorResponses(415) : {}),
      // Last, so a route can override a default description.
      ...route.responses,
    } as DefaultErrors<R> & R['responses'],
  })

const toValidationError = (target: string, error: z.ZodError) =>
  new ValidationError(
    'VALIDATION_FAILED',
    `Invalid ${target}`,
    error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
  )

/**
 * A sub-app for one module's routes (and the root app). Invalid input throws ValidationError,
 * so it reaches the client through errorHandler in the same shape as every other error.
 */
export const openapiApp = () =>
  new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) throw toValidationError(result.target, result.error)
    },
  })

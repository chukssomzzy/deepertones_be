import { createRoute, OpenAPIHono, type RouteConfig, z } from '@hono/zod-openapi'
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
 *     responses: { 200: json(TrackResponse, 'The track'), ...errorResponses(404) },
 *   })
 *   export const trackRoutes = openapiApp().openapi(getTrack, async (c) => ...)
 */

/** The body errorHandler renders for every error. Registered once as a component. */
export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().openapi({ description: 'Stable, machine-readable code.', example: 'NOT_FOUND' }),
      message: z.string().openapi({ description: 'Human-readable; may change. Branch on `code`.' }),
      details: z.unknown().optional().openapi({
        description: 'Extra context. For VALIDATION_FAILED: a list of `{ path, message }`, one per invalid field.',
      }),
      requestId: z.string().openapi({ description: 'Also sent as the X-Request-Id header. Quote it when reporting a bug.' }),
    }),
  })
  .openapi('ErrorResponse') satisfies z.ZodType<ErrorBody>

/**
 * The statuses errorHandler can produce: statusByKind in errors.ts, plus 415, which
 * @hono/zod-openapi throws (as an HTTPException) for a body with the wrong Content-Type.
 */
const errorDescriptions = {
  400: 'Invalid input (code VALIDATION_FAILED) or a broken business rule',
  401: 'Sign-in required',
  403: 'Signed in, but not allowed to do this',
  404: 'Not found',
  409: 'Conflicts with the current state',
  415: 'The body is not JSON (Content-Type must be application/json)',
  500: 'Unexpected server error',
} as const

type ErrorStatus = keyof typeof errorDescriptions

/** A JSON response: `200: json(TrackResponse, 'The track')`. */
export const json = <Schema extends z.ZodType>(schema: Schema, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})

/**
 * A required JSON request body: `request: { body: jsonBody(CreateTrackBody) }`.
 * `required: true` matters: without it, a request with no JSON Content-Type skips validation.
 */
export const jsonBody = <Schema extends z.ZodType>(schema: Schema) => ({
  required: true,
  content: { 'application/json': { schema } },
})

type ErrorResponses<S extends ErrorStatus> = { [K in S]: ReturnType<typeof json<typeof ErrorResponse>> }

/** The error statuses a route can produce, besides the ones defineRoute adds: `...errorResponses(401, 404)`. */
export const errorResponses = <S extends ErrorStatus>(...statuses: S[]) =>
  Object.fromEntries(
    statuses.map((status) => [status, json(ErrorResponse, errorDescriptions[status])]),
  ) as ErrorResponses<S>

/** What every route must say about itself. operationId names the method in generated clients. */
type DocumentedRoute = RouteConfig & { operationId: string; tags: [string, ...string[]] }

/** 500 on every route, 400 on any route that validates input, 415 on any route that takes a body. */
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

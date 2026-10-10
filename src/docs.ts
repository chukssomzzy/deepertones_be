import { swaggerUI } from '@hono/swagger-ui'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { type AppEnv, factory } from './lib/factory'

type OpenAPIDocumentConfig = Parameters<OpenAPIHono['getOpenAPI31Document']>[0]

/**
 * The spec's header. Shared by /openapi.json and `npm run openapi` (docs/openapi.json).
 *
 * info.version is the API contract's version, bumped by hand when the API breaks. It is not
 * package.json's version: release-please bumps that on every release, which would make the
 * committed spec stale in the release PR itself.
 */
/** Keep in step with `routes` in each env block of wrangler.jsonc. Production first. */
const servers = [
  { url: 'https://api.deepertones.com', description: 'Production' },
  { url: 'https://api.staging.deepertones.com', description: 'Staging' },
]

export const apiDocument: OpenAPIDocumentConfig = {
  openapi: '3.1.0',
  servers,
  info: {
    title: 'deepertones API',
    version: '1.0.0',
    description:
      'Every JSON response has an envelope, and `status` equals the HTTP status. ' +
      'Success: `{ success: true, status, message, data }`. ' +
      'Error: `{ success: false, status, message, error: { code, details?, requestId } }`. ' +
      'Branch on `success`, then on `error.code`, not on `message`.',
  },
}

/** Docs are served only where DOCS_ENABLED is "true" (wrangler.jsonc); elsewhere both paths 404. */
const docsEnabled = factory.createMiddleware(async (c, next) => {
  if (c.env.DOCS_ENABLED !== 'true') return c.notFound()
  await next()
})

/**
 * Swagger UI's JS and CSS come from jsDelivr. Pinned, so a new upstream release cannot change
 * what runs on our domain without a commit. Bump it deliberately.
 */
const SWAGGER_UI_VERSION = '5.33.1'

/**
 * Swagger UI's "Try it out" calls the first server. Served live, the spec lists the origin it is
 * served from first, so the staging docs try staging (and local docs try local), never production.
 */
const serversFor = (origin: string) => {
  const self = servers.find((server) => server.url === origin) ?? { url: origin, description: 'This server' }
  return [self, ...servers.filter((server) => server !== self)]
}

/** /openapi.json (generated from the app's routes) and Swagger UI at /docs. */
export const mountDocs = (app: OpenAPIHono<AppEnv>) => {
  app.get('/openapi.json', docsEnabled, (c) =>
    c.json(app.getOpenAPI31Document({ ...apiDocument, servers: serversFor(new URL(c.req.url).origin) })),
  )
  app.get('/docs', docsEnabled, swaggerUI({ url: '/openapi.json', title: 'deepertones API', version: SWAGGER_UI_VERSION }))
}

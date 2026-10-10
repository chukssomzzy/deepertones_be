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
export const apiDocument: OpenAPIDocumentConfig = {
  openapi: '3.1.0',
  info: {
    title: 'deepertones API',
    version: '1.0.0',
    description:
      'Every error response has the same body: `{ error: { code, message, details?, requestId } }`. ' +
      'Branch on `code`, not on `message`.',
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

/** /openapi.json (generated from the app's routes) and Swagger UI at /docs. */
export const mountDocs = (app: OpenAPIHono<AppEnv>) => {
  app.get('/openapi.json', docsEnabled, (c) => c.json(app.getOpenAPI31Document(apiDocument)))
  app.get('/docs', docsEnabled, swaggerUI({ url: '/openapi.json', title: 'deepertones API', version: SWAGGER_UI_VERSION }))
}

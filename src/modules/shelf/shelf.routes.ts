import type { z } from '@hono/zod-openapi'
import { ValidationError } from '../../lib/errors'
import { defineRoute, errorResponses, jsonBody, ok, openapiApp, success, toValidationError } from '../../lib/openapi'
import { ProductSummary } from '../scans/scans.schemas'
import { FALLBACK_IP, rateLimit } from '../../middleware/rate-limit'
import { signedIn } from '../../middleware/signed-in'
import { toEntryResponse, toShelfResponse } from './shelf.presenter'
import { AddShelfProductBody, AddShelfProductResponse, EntryParams, RemoveShelfEntryBody, ShelfEntryResponse, ShelfResponse } from './shelf.schemas'

const bearer = [{ bearerAuth: [] }]

const getShelf = defineRoute({
  method: 'get',
  path: '/shelf',
  operationId: 'getShelf',
  tags: ['Shelf'],
  summary: 'The products this profile uses',
  description:
    'Guests included. Every product a scan has put on the shelf, most recently scanned first, at most 200. A product scanned again is still one entry, pointing at the newest scan. ' +
    'A `product` entry carries `product`, the same summary a scan item shows; a `no-label` entry carries `noLabel`, the same view its scan item shows. Removed entries are left out.',
  security: bearer,
  responses: { 200: success(ShelfResponse, 'The shelf'), ...errorResponses(401) },
})

const addShelfProduct = defineRoute({
  method: 'post',
  path: '/shelf',
  operationId: 'addShelfProduct',
  tags: ['Shelf'],
  summary: 'Add a product found by search to the shelf',
  description:
    'Body `{ productId }`, a named product from `GET /api/v1/products/search`. A product already on the shelf is 200 with its entry, as `GET /api/v1/me/shelf` shows it, and nothing else happens. ' +
    'Otherwise 202 with `{ scanId, itemId }` of a `typed` scan (no photo, one item): a product already analysed is `ready`, and on the shelf, by the time this answers; ' +
    'one that still needs research or analysis is `researching` or `analysing` until a background job finishes it, so follow `GET /api/v1/scans/products/{scanId}` or its `/events`, then read the shelf. ' +
    'A product that needs research or analysis counts as one photo toward the daily limit (30 per user and 100 per address, 429 `SCAN_DAILY_LIMIT`); an analysed one counts for nothing and is never refused for it. ' +
    'The finished push is sent only for a scan that waited for a model. An unknown or unnamed product is 404 `PRODUCT_NOT_FOUND`. Adding a product taken off the shelf puts it back as the same entry.',
  security: bearer,
  // The order and the reasons are the scan routes': the address limit counts every caller, signedIn turns away the unsigned, the user limit needs a user.
  middleware: [rateLimit('SHELF_ADD_IP_LIMITER', 'ip'), signedIn(), rateLimit('SHELF_ADD_USER_LIMITER', 'user')],
  request: { body: jsonBody(AddShelfProductBody) },
  responses: {
    200: success(ShelfEntryResponse, 'The product was already on the shelf: its entry'),
    202: success(AddShelfProductResponse, 'A typed scan was started'),
    ...errorResponses(400, 401, 404, 429),
  },
})

const removeShelfEntry = defineRoute({
  method: 'delete',
  path: '/shelf/{entryId}',
  operationId: 'removeShelfEntry',
  tags: ['Shelf'],
  summary: 'Take a product off the shelf',
  description:
    'Optional JSON body `{ reason }`, one of `finished`, `stopped` or `not-mine`; no body, or `{}`, removes it with no reason. ' +
    'Removing an entry already removed is 204 again and keeps the first reason. Another profile\'s entry is 404 `SHELF_ENTRY_NOT_FOUND`, the same as one that never existed. ' +
    'Scanning the product again puts it back on the shelf.',
  security: bearer,
  request: { params: EntryParams, body: { required: false, content: { 'application/json': { schema: RemoveShelfEntryBody } } } },
  responses: { 204: { description: 'The entry is off the shelf' }, ...errorResponses(400, 401, 404) },
})

// The documented routes above carry their JSON bodies for the spec. They are served from copies without them: @hono/zod-openapi
// reports a malformed JSON body as HTTP_400 rather than VALIDATION_FAILED, and validates JSON whenever the Content-Type says JSON, so an
// empty body then fails as malformed. The remove route must also let a client that always sends the header remove with no reason.
const removeShelfEntryServed = { ...removeShelfEntry, request: { params: EntryParams }, hide: true }
const addShelfProductServed = { ...addShelfProduct, request: {}, hide: true }

const readBody = <Schema extends z.ZodType>(text: string, schema: Schema): z.infer<Schema> => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ValidationError('VALIDATION_FAILED', 'Invalid json', [{ path: '', message: 'Malformed JSON in request body' }])
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw toValidationError('json', parsed.error)
  return parsed.data
}

/** No text, or only whitespace, is no reason; anything else must be a valid RemoveShelfEntryBody. */
const readRemoveBody = (text: string) => (text.trim() === '' ? {} : readBody(text, RemoveShelfEntryBody))

// The client address is Cloudflare's own header, as in rateLimit and the scan routes. The service hashes it for the daily per-address quota.

const shelfApp = openapiApp()
// Registered ahead of its first use, so the component keeps its own shape: left to the generator, it takes the description of the
// first field that uses it, and the shelf entry's would then stand for the scan item's too.
shelfApp.openAPIRegistry.register('ProductSummary', ProductSummary)

export const shelfRoutes = shelfApp
  .openapi(getShelf, async (c) => ok(c, toShelfResponse(await c.var.services.shelf.list()), 'Shelf'))
  .openapi(addShelfProductServed, async (c) => {
    const { productId } = readBody(await c.req.text(), AddShelfProductBody)
    const added = await c.var.services.shelf.add(productId, c.req.header('cf-connecting-ip') ?? FALLBACK_IP)
    if (added.status === 'exists') return ok(c, toEntryResponse(added.entry), 'Already on the shelf', 200)
    return ok(c, { scanId: added.scanId, itemId: added.itemId }, 'Scan started', 202)
  })
  .openapi(removeShelfEntryServed, async (c) => {
    const { reason } = readRemoveBody(await c.req.text())
    await c.var.services.shelf.remove(c.req.valid('param').entryId, reason)
    return c.body(null, 204)
  })

// defineRoute adds 415 to any route with a body, but these are served by reading the text, which never refuses a Content-Type: do not document it.
const withoutUnsupportedMediaType = <Route extends { responses: object }>(route: Route): Route => {
  const { 415: _unsupported, ...responses } = route.responses as Record<number, unknown>
  return { ...route, responses }
}

shelfRoutes.openAPIRegistry.registerPath(withoutUnsupportedMediaType(addShelfProduct))
shelfRoutes.openAPIRegistry.registerPath(withoutUnsupportedMediaType(removeShelfEntry))

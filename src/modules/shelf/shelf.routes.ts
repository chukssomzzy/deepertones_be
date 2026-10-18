import { ValidationError } from '../../lib/errors'
import { defineRoute, errorResponses, ok, openapiApp, success, toValidationError } from '../../lib/openapi'
import { ProductSummary } from '../scans/scans.schemas'
import { toShelfResponse } from './shelf.presenter'
import { EntryParams, RemoveShelfEntryBody, ShelfResponse } from './shelf.schemas'

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

// The documented route above carries the optional body for the spec. It is served from a body-less copy because
// @hono/zod-openapi validates JSON whenever the Content-Type says JSON, and an empty body then fails as malformed JSON;
// a client that always sends the header must still be able to remove with no reason.
const removeShelfEntryServed = { ...removeShelfEntry, request: { params: EntryParams }, hide: true }

/** No text, or only whitespace, is no reason; anything else must be a valid RemoveShelfEntryBody. */
const readRemoveBody = (text: string) => {
  if (text.trim() === '') return {}
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ValidationError('VALIDATION_FAILED', 'Invalid json', [{ path: '', message: 'Malformed JSON in request body' }])
  }
  const parsed = RemoveShelfEntryBody.safeParse(raw)
  if (!parsed.success) throw toValidationError('json', parsed.error)
  return parsed.data
}

const shelfApp = openapiApp()
// Registered ahead of its first use, so the component keeps its own shape: left to the generator, it takes the description of the
// first field that uses it, and the shelf entry's would then stand for the scan item's too.
shelfApp.openAPIRegistry.register('ProductSummary', ProductSummary)

export const shelfRoutes = shelfApp
  .openapi(getShelf, async (c) => ok(c, toShelfResponse(await c.var.services.shelf.list()), 'Shelf'))
  .openapi(removeShelfEntryServed, async (c) => {
    const { reason } = readRemoveBody(await c.req.text())
    await c.var.services.shelf.remove(c.req.valid('param').entryId, reason)
    return c.body(null, 204)
  })

shelfRoutes.openAPIRegistry.registerPath(removeShelfEntry)

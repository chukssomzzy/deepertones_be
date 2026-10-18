import { defineRoute, errorResponses, ok, openapiApp, success } from '../../lib/openapi'
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

export const shelfRoutes = openapiApp()
  .openapi(getShelf, async (c) => ok(c, toShelfResponse(await c.var.services.shelf.list()), 'Shelf'))
  .openapi(removeShelfEntry, async (c) => {
    // No body at all skips validation, so there is nothing to read.
    const body = c.req.valid('json') as { reason?: 'finished' | 'stopped' | 'not-mine' } | undefined
    await c.var.services.shelf.remove(c.req.valid('param').entryId, body?.reason)
    return c.body(null, 204)
  })

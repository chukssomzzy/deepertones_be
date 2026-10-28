import type { z } from '@hono/zod-openapi'
import { defineRoute, errorResponses, jsonBody, ok, openapiApp, success } from '../../lib/openapi'
import { signedIn } from '../../middleware/signed-in'
import { InboxQuery, InboxResponse, MarkInboxReadBody, MarkInboxReadResponse } from './inbox.schemas'
import type { InboxItemView } from './inbox.service'

const bearer = [{ bearerAuth: [] }]

const toInboxResponse = ({ items, next }: { items: InboxItemView[]; next: string | null }): z.infer<typeof InboxResponse> => ({
  items: items.map(({ id, kind, day, title, body, link, read, createdAt }) => ({ id, kind, day, title, body, link, read, createdAt: createdAt.toISOString() })),
  next,
})

const getInbox = defineRoute({
  method: 'get',
  path: '/inbox',
  operationId: 'getInbox',
  tags: ['Inbox'],
  summary: 'What the routine has told the profile, newest first',
  description:
    'For a signed-up account: 401 without a session, 403 `SIGNUP_REQUIRED` for a guest. Each profile has its own inbox, and its items are kept for good. ' +
    'Pages are `limit` items (default 20, 1 to 50 or 400 `VALIDATION_FAILED`); follow `next` as `before` until it is null. A `before` that is no item of the caller\'s is 404 `INBOX_ITEM_NOT_FOUND`.',
  security: bearer,
  request: { query: InboxQuery },
  responses: { 200: success(InboxResponse, 'A page of inbox items'), ...errorResponses(400, 401, 403, 404) },
})

const markInboxRead = defineRoute({
  method: 'post',
  path: '/inbox/read',
  operationId: 'markInboxRead',
  tags: ['Inbox'],
  summary: 'Mark an item and everything older as read',
  description:
    'Marks the item `upTo` and every older unread item read, and answers how many are still unread. It is idempotent, and an item already read keeps the time it was first read. ' +
    'An item that is no item of the caller\'s is 404 `INBOX_ITEM_NOT_FOUND`. 401 without a session, 403 `SIGNUP_REQUIRED` for a guest.',
  security: bearer,
  // An unsigned caller is turned away before the body is checked, so a bodiless request answers 401 and not 400.
  middleware: [signedIn()],
  request: { body: jsonBody(MarkInboxReadBody) },
  responses: { 200: success(MarkInboxReadResponse, 'How many items are still unread'), ...errorResponses(400, 401, 403, 404) },
})

export const inboxRoutes = openapiApp()
  .openapi(getInbox, async (c) => ok(c, toInboxResponse(await c.var.services.inbox.list(c.req.valid('query'))), 'Inbox'))
  .openapi(markInboxRead, async (c) => ok(c, await c.var.services.inbox.markRead(c.req.valid('json').upTo), 'Inbox marked read'))

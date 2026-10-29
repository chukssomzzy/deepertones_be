import { z } from '@hono/zod-openapi'

export const InboxQuery = z.object({
  before: z.string().min(1).optional().openapi({ description: 'The `next` of the page before. Anything that is no item of the caller\'s is 404 `INBOX_ITEM_NOT_FOUND`.' }),
  limit: z.coerce.number().int().min(1).max(50).optional().openapi({ description: 'How many items to answer, 1 to 50 (default 20). Anything else is 400 `VALIDATION_FAILED`.', example: 20 }),
})

export const InboxItemParams = z.object({ id: z.string().openapi({ description: 'The id of an inbox item, such as the `inboxId` a push carries.' }) })

export const InboxResponse = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string(),
          kind: z.string().openapi({ description: 'What happened, such as `reminder`, `step-down` or `rest-night`. Open-ended: show the title and body, not a name picked from the kind.' }),
          day: z.string().openapi({ description: 'The local calendar day the item is about, `YYYY-MM-DD`.', example: '2030-06-15' }),
          title: z.string(),
          body: z.string(),
          link: z.string().openapi({ description: 'An in-app path to open when the item is tapped.', example: '/routine' }),
          read: z.boolean(),
          createdAt: z.string().openapi({ format: 'date-time' }),
        }),
      )
      .openapi({ description: 'Newest first. Items are kept for good.' }),
    next: z.string().nullable().openapi({ description: 'Send as `before` for the next, older page. Null when no older item follows.' }),
  })
  .openapi('Inbox')

export const MarkInboxReadBody = z
  .object({ upTo: z.string().min(1).openapi({ description: 'The id of an item. It and every older item are marked read.' }) })
  .openapi('MarkInboxReadBody')

export const MarkInboxReadResponse = z.object({ unread: z.number().int().openapi({ description: 'How many items are still unread.' }) }).openapi('MarkInboxReadResult')

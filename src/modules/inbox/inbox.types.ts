import type { inboxItems } from './inbox.table'

/** The whole stored row. The service hides `key` and `profileId`; nothing outside this module sees them. */
export type InboxItem = typeof inboxItems.$inferSelect

/** A row as written: it starts unread, and the caller supplies the id and the time. */
export type NewInboxItem = Omit<InboxItem, 'readAt'>

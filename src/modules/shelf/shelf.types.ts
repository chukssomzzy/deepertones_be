import type { profileProducts } from './shelf.table'

/** A shelf row as stored, removed ones included. */
export type ShelfEntryRow = typeof profileProducts.$inferSelect

export type ShelfRemovedReason = NonNullable<ShelfEntryRow['removedReason']>

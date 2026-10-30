import type { profileProducts } from './shelf.table'

/** A shelf row as stored, removed ones included. */
export type ShelfEntryRow = typeof profileProducts.$inferSelect

export type ShelfRemovedReason = NonNullable<ShelfEntryRow['removedReason']>

/** The reasons a person can give when removing: `wrong-product` is written by the swap alone, so it is not one of them. */
export type ShelfPublicRemovedReason = Exclude<ShelfRemovedReason, 'wrong-product'>

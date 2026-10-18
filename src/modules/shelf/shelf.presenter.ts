import type { z } from '@hono/zod-openapi'
import { toNoLabelResponse, toProductResponse } from '../scans/scans.presenter'
import type { ShelfEntryResponse, ShelfResponse } from './shelf.schemas'
import type { ShelfEntryView, ShelfView } from './shelf.service'

export const toEntryResponse = (entry: ShelfEntryView): z.infer<typeof ShelfEntryResponse> => ({
  id: entry.id,
  addedAt: entry.addedAt.toISOString(),
  lastScannedAt: entry.lastScannedAt.toISOString(),
  source: { scanId: entry.source.scanId, itemId: entry.source.itemId },
  kind: entry.kind,
  ...(entry.product ? { product: toProductResponse(entry.product) } : {}),
  ...(entry.noLabel ? { noLabel: toNoLabelResponse(entry.noLabel) } : {}),
})

export const toShelfResponse = ({ entries }: ShelfView): z.infer<typeof ShelfResponse> => ({ entries: entries.map(toEntryResponse) })

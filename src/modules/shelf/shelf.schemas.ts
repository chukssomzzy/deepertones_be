import { z } from '@hono/zod-openapi'
import { NoLabelResponse, ProductSummary } from '../scans/scans.schemas'

export const EntryParams = z.object({
  entryId: z.uuid().openapi({ param: { name: 'entryId', in: 'path' }, description: 'The shelf entry\'s `id`, from `GET /api/v1/me/shelf`.' }),
})

// Strict, so a misspelt key is refused rather than read as "no reason".
export const RemoveShelfEntryBody = z
  .strictObject({
    reason: z.enum(['finished', 'stopped', 'not-mine']).optional().openapi({ description: 'Why the product left the shelf. Leave it out when the user did not say.' }),
  })
  .openapi('RemoveShelfEntryBody')

export const ShelfEntryResponse = z
  .object({
    id: z.string().openapi({ description: 'The entry\'s own id, kept when the product is scanned again. Use it to remove the entry.' }),
    addedAt: z.iso.datetime().openapi({ description: 'When the product first reached the shelf.' }),
    lastScannedAt: z.iso.datetime().openapi({ description: 'When it was last scanned. The shelf is ordered by this, newest first.' }),
    source: z.object({ scanId: z.string(), itemId: z.string() }).openapi({ description: 'The scan and item the entry was last read from.' }),
    kind: z.enum(['product', 'no-label']).openapi({ description: '`product` carries `product`; `no-label` carries `noLabel`.' }),
    product: ProductSummary.optional().openapi({ description: 'Only on a `product` entry: the same summary a scan item shows.' }),
    noLabel: NoLabelResponse.optional().openapi({ description: 'Only on a `no-label` entry: what the user said about it, and the cautions that earns.' }),
  })
  .openapi('ShelfEntry')

export const ShelfResponse = z
  .object({
    entries: z.array(ShelfEntryResponse).openapi({ description: 'The products the profile uses, most recently scanned first, at most 200.' }),
  })
  .openapi('Shelf')

export const AddShelfProductBody = z
  .strictObject({ productId: z.string().min(1).openapi({ description: 'A product id from `GET /api/v1/products/search`.' }) })
  .openapi('AddShelfProductBody')

export const ReplaceShelfEntryBody = z
  .strictObject({ productId: z.string().min(1).openapi({ description: 'The product the entry really is, from `GET /api/v1/products/search`. Not the entry\'s own product.' }) })
  .openapi('ReplaceShelfEntryBody')

export const AddShelfProductResponse = z
  .object({
    scanId: z.string().openapi({ description: 'The typed scan made for the add. Follow it with `GET /api/v1/scans/products/{scanId}` or its `/events`.' }),
    itemId: z.string().openapi({ description: 'Its one item. When the item is `ready` the product is on the shelf.' }),
  })
  .openapi('AddShelfProductResult')

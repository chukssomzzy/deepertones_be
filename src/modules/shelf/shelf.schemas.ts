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

// Strict, and the ids unique: naming one twice is a client error, not a second removal. They are not UUIDs here, so a made-up id is the same 404 as an unknown UUID.
export const RemoveShelfEntriesBody = z
  .strictObject({
    entryIds: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, 'entryIds must be unique')
      .openapi({ description: 'The shelf entries to take off, 1 to 50 different ids, from `GET /api/v1/me/shelf`.' }),
    reason: z.enum(['finished', 'stopped', 'not-mine']).optional().openapi({ description: 'Why the products left the shelf, for all of them. Leave it out when the user did not say.' }),
  })
  .openapi('RemoveShelfEntriesBody')

export const RemoveShelfEntriesResponse = z
  .object({
    removed: z.array(z.string()).openapi({ description: 'The ids this call took off the shelf, in the order asked for. An id removed before is accepted but not listed.' }),
    stepDownWarnings: z
      .array(
        z.object({
          entryId: z.string().openapi({ description: 'A removed entry whose product the current verdict says to stop.' }),
          taperCode: z
            .string()
            .nullable()
            .openapi({
              description:
                'For a verified user, the step-down to ease off it with: the `code` of an entry of `tapers` in `GET /api/v1/me/verdict`, which carries `whatToExpect` and `seeAProfessionalIf`. `null` for a guest, who is served only the locked verdict preview.',
            }),
          line: z.string().openapi({ description: 'A fixed plain-words warning to show, which stands on its own: for a guest it points at signing up to see the step-down.' }),
        }),
      )
      .openapi({ description: 'In the order asked for. Empty when the verdict is pending, out of date or unavailable, or stops none of the removed products.' }),
  })
  .openapi('RemoveShelfEntriesResult')

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

import { z } from '@hono/zod-openapi'
import { PRODUCT_FORMS } from '../catalog/catalog.vocabulary'
import { SCAN_POLICY } from './scans.service'
import { NO_LABEL_PURPOSES, NO_LABEL_SOURCES, NO_LABEL_USED_FOR } from './scans.vocabulary'

const Category = z.enum(['skin', 'hair', 'body', 'makeup', 'other'])

export const ScanParams = z.object({ scanId: z.string() })
export const ItemParams = z.object({ scanId: z.string(), itemId: z.string() })
// Any length: a token that is too long or not ours is PHOTO_NOT_FOUND from the service, the same as every other bad link.
export const PhotoLinkParams = z.object({ token: z.string() })

// The generator cannot describe a File on its own. z.instanceof(File), not z.file(): under workers-types only the former infers
// name, arrayBuffer() and stream(). There is deliberately no check of `type` or `size` here: what the client declares is not what the
// bytes are, so the service reads the bytes and answers UNSUPPORTED_IMAGE or IMAGE_TOO_LARGE with a code the app can act on.
const PhotoFile = z.instanceof(File).openapi({ type: 'string', format: 'binary', description: 'A JPEG or WebP photo, at most 2,000,000 bytes and 1600 pixels on the longest side.' })

// Hono hands over one File for one value and File[] for several, so a one-photo scan is normalised to a list. How many photos is the
// service's to judge (NO_IMAGES, TOO_MANY_IMAGES), so the app gets a code it can act on rather than a generic VALIDATION_FAILED.
const asList = (photos: File | File[]) => (Array.isArray(photos) ? photos : [photos])

const photosField = (maxItems: number, description: string) =>
  z
    .union([z.instanceof(File), z.array(z.instanceof(File))])
    .transform(asList)
    .pipe(z.array(PhotoFile))
    // The union and the transform are opaque to the generator, so the field is described by hand.
    .openapi({ type: 'array', items: { type: 'string', format: 'binary' }, minItems: 1, maxItems, description })

export const CreateScanBody = z
  .object({ photos: photosField(SCAN_POLICY.maxPhotosPerScan, 'One `photos` part per photo, in the order the items should appear.') })
  .openapi('CreateScanBody')

export const CreateShelfScanBody = z
  .object({ photos: photosField(SCAN_POLICY.maxShelfPhotos, 'One `photos` part per photo of a shelf, in the order the photos should appear. Each photo can show up to 5 products.') })
  .openapi('CreateShelfScanBody')

export const BackPhotoBody = z.object({ photo: PhotoFile }).openapi('BackPhotoBody')

export const RetakeBody = z.object({ photo: PhotoFile }).openapi('RetakeBody')

export const ConfirmProductBody = z
  .object({
    brand: z.string().min(1),
    name: z.string().min(1),
    variant: z.string().optional(),
    form: z.enum(PRODUCT_FORMS).optional(),
    category: Category,
  })
  .openapi('ConfirmProductBody')

// Exactly one of the two: a strict object each, so neither `{}` nor both fields at once validates. The text's length and content are the
// service's to judge (INVALID_PRODUCT_TEXT), as for a confirmation.
export const IdentifyProductBody = z
  .union([
    z.strictObject({ productId: z.string().min(1).openapi({ description: 'A product id from `GET /api/v1/products/search`.' }) }),
    z.strictObject({ text: z.string().openapi({ description: 'A product name the user typed, 2 to 120 characters once trimmed, with no link, markup or hidden character.' }) }),
  ])
  .openapi('IdentifyProductBody')

const Source = z.enum(NO_LABEL_SOURCES).openapi({ description: 'Where the product came from.' })
const Purpose = z.enum(NO_LABEL_PURPOSES).openapi({ description: 'What the product is used for.' })
const UsedFor = z.enum(NO_LABEL_USED_FOR).openapi({ description: 'How long the product has been used.' })

// The user's answers for a product with no label. The description's length and content are the service's to judge (INVALID_PRODUCT_TEXT, field `description`).
export const NoLabelBody = z
  .object({
    source: Source,
    purpose: Purpose,
    usedFor: UsedFor,
    description: z.string().optional().openapi({ description: 'Anything else the user wants to note, at most 200 characters once trimmed, with no link, markup or hidden character. Blank is the same as left out.' }),
  })
  .openapi('NoLabelBody')

const Concern = z.object({
  kind: z.string(),
  severity: z.string(),
  ingredients: z.array(z.string()),
  why: z.string(),
  whoShouldTakeCare: z.string(),
  traits: z.array(z.string()),
  sources: z.array(z.string()),
})

export const ProductSummary = z
  .object({
    id: z.string(),
    kind: z.enum(['named', 'unnamed']).openapi({
      description: 'An `unnamed` product is an ingredient list the label gave no brand and name for: its `brand` and `name` are empty strings and its `category` is `other` unless the label said otherwise.',
    }),
    brand: z.string(),
    name: z.string(),
    variant: z.string().nullable(),
    form: z.enum(PRODUCT_FORMS).nullable(),
    category: Category,
    imageUrl: z.string().nullable(),
  })
  .openapi('ProductSummary')

/** What the user said about a product with no label, and the cautions that earns. Shared by a scan item and a shelf entry. */
export const NoLabelResponse = z.object({
  source: Source,
  purpose: Purpose,
  usedFor: UsedFor,
  description: z.string().optional().openapi({ description: 'What the user noted, if anything.' }),
  concerns: z.array(Concern).openapi({ description: 'Cautions for a product of unknown contents, worked out from the answers each time the item is shown. Not an analysis of any label.' }),
  rulesVersion: z.number().int().openapi({ description: 'Which version of the caution rules wrote `concerns`.' }),
})

export const ScanItemResponse = z
  .object({
    id: z.string(),
    photoId: z.string().nullable().openapi({ description: 'The photo in the scan\'s `photos` this item was read from. Null only for an item from before photos were listed.' }),
    position: z.number().int().openapi({ description: 'The item\'s place in the scan, from 0. On a shelf scan the positions of one photo\'s items are not consecutive across photos; sort by them, do not index by them.' }),
    state: z
      .enum(['recognising', 'needs-confirmation', 'matching', 'researching', 'needs-back-photo', 'reading-label', 'analysing', 'ready', 'rejected', 'failed', 'needs-retake', 'needs-identification', 'unidentified'])
      .openapi({
        description:
          '`ready`, `rejected`, `failed` and `unidentified` are final. `needs-confirmation` waits for the corrected product, `needs-back-photo` for a photo of the ingredient list and `needs-retake` for a new photo of the front (see `retakesLeft`); ' +
          '`needs-identification` is where an item lands once its 3rd front photo could not be read; `unidentified` is where it ends when the user says the product has no label (see `noLabel`); the others are being worked on.',
      }),
    reason: z
      .enum(['face-or-person', 'not-a-beauty-product', 'unreadable', 'photo-missing', 'analysis-failed', 'research-busy', 'unavailable', 'label-unreadable', 'label-not-visible'])
      .nullable()
      .openapi({
        description:
          'Why the item is `rejected` or `failed`, or why it asks for the back photo again (`label-unreadable`; also the reason it fails once the 3rd back photo cannot be read), ' +
          'or why its front photo could not be used (`unreadable`, or `label-not-visible` when a product is in view but its label is turned away or covered), in `needs-retake` and `needs-identification`.',
      }),
    retakesLeft: z.number().int().min(0).optional().openapi({ description: 'Only on an item in `needs-retake`: how many more front photos it may be sent. Absent in every other state.' }),
    recognised: z
      .object({ brand: z.string(), name: z.string(), variant: z.string().nullable(), form: z.enum(PRODUCT_FORMS).nullable(), category: Category })
      .optional()
      .openapi({ description: 'What the photo was read as, or what the user corrected it to. Absent until it has been read.' }),
    product: ProductSummary.optional().openapi({
      description: 'The product\'s identity, only on a `ready` item. Its ingredients and concerns are not part of a scan.',
    }),
    noLabel: NoLabelResponse.optional()
      .openapi({ description: 'Only on an `unidentified` item: what the user said about the product, and the cautions that earns.' }),
    image: z
      .object({
        kind: z.enum(['stock', 'user']),
        url: z.string().openapi({ description: 'A path on this API, or an absolute URL for a stock image. A `user` link works for 5 minutes and needs no Authorization header.' }),
      })
      .nullable(),
  })
  .openapi('ScanItem')

export const ScanPhotoResponse = z
  .object({
    id: z.string(),
    position: z.number().int().openapi({ description: 'The photo\'s place in the upload, from 0.' }),
    state: z.enum(['recognising', 'recognised', 'rejected']).openapi({
      description: '`recognising` until the photo has been read; `recognised` once its products are items; `rejected` when no product could be read in it (its one item is `rejected` too). A product scan\'s photos stay `recognising`: their items carry the outcome.',
    }),
    skipped: z
      .object({
        notBeauty: z.number().int().openapi({ description: 'Products in view that are not skincare, hair, body or makeup.' }),
        unreadable: z.number().int().openapi({ description: 'Products in view that could not be read.' }),
        overLimit: z.number().int().openapi({ description: 'Products read but left out: more than 5 on the photo, or the scan already holds 20 items.' }),
        dailyLimit: z.number().int().openapi({ description: 'Products read but left out because the daily limit was reached.' }),
      })
      .openapi({ description: 'What the photo showed that did not become an item. All zero until the photo is read, and on a product scan.' }),
  })
  .openapi('ScanPhoto')

export const ScanResponse = z
  .object({
    id: z.string(),
    createdAt: z.iso.datetime(),
    kind: z.enum(['product', 'shelf', 'typed']).openapi({
      description: '`product` when each photo is one product; `shelf` when each photo is read for up to 5; `typed` when a named product was added to the shelf from search, with no photo and one item.',
    }),
    photos: z.array(ScanPhotoResponse).openapi({ description: 'The uploaded photos, in upload order.' }),
    items: z.array(ScanItemResponse).openapi({ description: 'One per product, in position order. A product scan has one per photo; a shelf scan starts with one per photo and gains the others as each photo is read.' }),
  })
  .openapi('Scan')

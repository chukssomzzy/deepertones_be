import { z } from '@hono/zod-openapi'
import { PRODUCT_FORMS } from '../catalog/catalog.vocabulary'
import { SCAN_POLICY } from './scans.service'

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

export const CreateScanBody = z
  .object({
    photos: z
      .union([z.instanceof(File), z.array(z.instanceof(File))])
      .transform(asList)
      .pipe(z.array(PhotoFile))
      // The union and the transform are opaque to the generator, so the field is described by hand.
      .openapi({
        type: 'array',
        items: { type: 'string', format: 'binary' },
        minItems: 1,
        maxItems: SCAN_POLICY.maxPhotosPerScan,
        description: 'One `photos` part per photo, in the order the items should appear.',
      }),
  })
  .openapi('CreateScanBody')

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

const ProductResult = z
  .object({
    product: z.object({
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
    }),
    formulation: z.object({
      id: z.string(),
      ingredients: z.array(z.string()).openapi({ description: 'In label (INCI) order.' }),
      source: z.object({ kind: z.enum(['web', 'label']), url: z.string().nullable() }),
      foundAt: z.iso.datetime(),
      analysedAt: z.iso.datetime().nullable(),
    }),
    concerns: z.array(
      z.object({
        kind: z.string(),
        severity: z.string(),
        ingredients: z.array(z.string()),
        why: z.string(),
        whoShouldTakeCare: z.string(),
        traits: z.array(z.string()),
        sources: z.array(z.string()),
      }),
    ),
    reference: z.object({
      version: z.string(),
      coverage: z.string().openapi({ description: 'How much of the regulatory lists the checks cover. A result with no concerns is not an all-clear unless this says so.' }),
    }),
  })
  .openapi('ProductResult')

export const ScanItemResponse = z
  .object({
    id: z.string(),
    position: z.number().int().openapi({ description: 'The photo\'s place in the upload, from 0.' }),
    state: z
      .enum(['recognising', 'needs-confirmation', 'matching', 'researching', 'needs-back-photo', 'reading-label', 'analysing', 'ready', 'rejected', 'failed', 'needs-retake', 'needs-identification'])
      .openapi({
        description:
          '`ready`, `rejected` and `failed` are final. `needs-confirmation` waits for the corrected product, `needs-back-photo` for a photo of the ingredient list and `needs-retake` for a new photo of the front (see `retakesLeft`); ' +
          '`needs-identification` is where an item lands once its 3rd front photo could not be read; the others are being worked on.',
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
    product: ProductResult.optional().openapi({ description: 'Only on a `ready` item.' }),
    image: z
      .object({
        kind: z.enum(['stock', 'user']),
        url: z.string().openapi({ description: 'A path on this API, or an absolute URL for a stock image. A `user` link works for 5 minutes and needs no Authorization header.' }),
      })
      .nullable(),
  })
  .openapi('ScanItem')

export const ScanResponse = z
  .object({
    id: z.string(),
    createdAt: z.iso.datetime(),
    items: z.array(ScanItemResponse).openapi({ description: 'One per photo, in photo order.' }),
  })
  .openapi('Scan')

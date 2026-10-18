import type { z } from '@hono/zod-openapi'
import type { ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import type { ProductSummary } from '../catalog/catalog.service'
import type { ScanItemResponse, ScanPhotoResponse, ScanResponse } from './scans.schemas'
import type { ScanItemView, ScanPhotoView, ScanView } from './scans.service'

type ConcernResponse = NonNullable<z.infer<typeof ScanItemResponse>['noLabel']>['concerns'][number]

const toConcernResponse = (concern: ConcernResponse): ConcernResponse => ({
  kind: concern.kind,
  severity: concern.severity,
  ingredients: concern.ingredients,
  why: concern.why,
  whoShouldTakeCare: concern.whoShouldTakeCare,
  traits: concern.traits,
  sources: concern.sources,
})

// Every field is named, so a field added to the catalog's summary is not published by accident.
export const toProductResponse = (product: ProductSummary): NonNullable<z.infer<typeof ScanItemResponse>['product']> => ({
  id: product.id,
  kind: product.kind,
  brand: product.brand,
  name: product.name,
  variant: product.variant,
  form: product.form,
  category: product.category,
  imageUrl: product.imageUrl,
})

export const toNoLabelResponse = ({ source, purpose, usedFor, description, concerns, rulesVersion }: NonNullable<ScanItemView['noLabel']>): NonNullable<z.infer<typeof ScanItemResponse>['noLabel']> => ({
  source,
  purpose,
  usedFor,
  ...(description === undefined ? {} : { description }),
  concerns: concerns.map(toConcernResponse),
  rulesVersion,
})

export const toScanItemResponse = (item: ScanItemView): z.infer<typeof ScanItemResponse> => ({
  id: item.id,
  photoId: item.photoId,
  position: item.position,
  state: item.state,
  reason: item.reason,
  ...(item.retakesLeft === undefined ? {} : { retakesLeft: item.retakesLeft }),
  ...(item.recognised
    ? {
        recognised: {
          brand: item.recognised.brand,
          name: item.recognised.name,
          variant: item.recognised.variant,
          form: item.recognised.form,
          category: item.recognised.category,
        },
      }
    : {}),
  ...(item.product ? { product: toProductResponse(item.product) } : {}),
  ...(item.noLabel ? { noLabel: toNoLabelResponse(item.noLabel) } : {}),
  image: item.image ? { kind: item.image.kind, url: item.image.url } : null,
})

export const toScanPhotoResponse = (photo: ScanPhotoView): z.infer<typeof ScanPhotoResponse> => ({
  id: photo.id,
  position: photo.position,
  state: photo.state,
  skipped: {
    notBeauty: photo.skipped.notBeauty,
    unreadable: photo.skipped.unreadable,
    overLimit: photo.skipped.overLimit,
    dailyLimit: photo.skipped.dailyLimit,
  },
})

export const toScanResponse = (scan: ScanView): z.infer<typeof ScanResponse> => ({
  id: scan.id,
  createdAt: scan.createdAt.toISOString(),
  kind: scan.kind,
  photos: scan.photos.map(toScanPhotoResponse),
  items: scan.items.map(toScanItemResponse),
})

const IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp']

/**
 * The upload as the service takes it. The declared type is only carried along: the service reads the type from the bytes
 * and never trusts it, so a type it does not know falls back to JPEG rather than being refused here.
 */
export const toProductImage = async (file: File): Promise<ProductImage> => ({
  bytes: new Uint8Array(await file.arrayBuffer()),
  mediaType: IMAGE_TYPES.includes(file.type) ? (file.type as ProductImage['mediaType']) : 'image/jpeg',
})

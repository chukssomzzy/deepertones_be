import type { z } from '@hono/zod-openapi'
import type { ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import type { ProductView } from '../catalog/catalog.service'
import type { ScanItemResponse, ScanResponse } from './scans.schemas'
import type { ScanItemView, ScanView } from './scans.service'

// Every field is named, so a field added to the catalog's view is not published by accident.
const toProductResponse = ({ product, formulation, concerns, reference }: ProductView): NonNullable<z.infer<typeof ScanItemResponse>['product']> => ({
  product: {
    id: product.id,
    brand: product.brand,
    name: product.name,
    variant: product.variant,
    category: product.category,
    imageUrl: product.imageUrl,
  },
  formulation: {
    id: formulation.id,
    ingredients: formulation.ingredients,
    source: { kind: formulation.source.kind, url: formulation.source.url },
    foundAt: formulation.foundAt.toISOString(),
    analysedAt: formulation.analysedAt?.toISOString() ?? null,
  },
  concerns: concerns.map((concern) => ({
    kind: concern.kind,
    severity: concern.severity,
    ingredients: concern.ingredients,
    why: concern.why,
    whoShouldTakeCare: concern.whoShouldTakeCare,
    traits: concern.traits,
    sources: concern.sources,
  })),
  reference: { version: reference.version, coverage: reference.coverage },
})

export const toScanItemResponse = (item: ScanItemView): z.infer<typeof ScanItemResponse> => ({
  id: item.id,
  position: item.position,
  state: item.state,
  reason: item.reason,
  ...(item.recognised
    ? { recognised: { brand: item.recognised.brand, name: item.recognised.name, variant: item.recognised.variant, category: item.recognised.category } }
    : {}),
  ...(item.product ? { product: toProductResponse(item.product) } : {}),
  image: item.image ? { kind: item.image.kind, url: item.image.url } : null,
})

export const toScanResponse = (scan: ScanView): z.infer<typeof ScanResponse> => ({
  id: scan.id,
  createdAt: scan.createdAt.toISOString(),
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

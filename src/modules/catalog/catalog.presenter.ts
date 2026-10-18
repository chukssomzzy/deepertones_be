import type { z } from '@hono/zod-openapi'
import type { ProductSearchResponse } from './catalog.schemas'
import type { ProductSummary } from './catalog.service'

// Every field is named, so a field added to the summary is not published by accident.
export const toProductSearchResponse = (products: ProductSummary[]): z.infer<typeof ProductSearchResponse> => ({
  products: products.map(({ id, brand, name, variant, category, imageUrl }) => ({ id, brand, name, variant, category, imageUrl })),
})

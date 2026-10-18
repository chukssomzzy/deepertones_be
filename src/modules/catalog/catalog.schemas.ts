import { z } from '@hono/zod-openapi'
import { CATEGORIES, PRODUCT_FORMS } from './catalog.vocabulary'

// Trimmed first, then measured: what a person types around the words does not count. 2 to 80 characters: one letter would match most of the catalog.
export const SearchProductsQuery = z.object({
  q: z.string().trim().min(2).max(80).openapi({ description: 'What the user typed: a fragment of the brand, name or variant. Case, accents and punctuation do not matter.' }),
})

export const ProductSearchResponse = z
  .object({
    products: z
      .array(
        z.object({
          id: z.string(),
          brand: z.string(),
          name: z.string(),
          variant: z.string().nullable(),
          form: z.enum(PRODUCT_FORMS).nullable(),
          category: z.enum(CATEGORIES),
          imageUrl: z.string().nullable().openapi({ description: 'The product\'s stock image, an absolute URL, if it has one.' }),
        }),
      )
      .openapi({ description: 'At most 10, best first: those whose search text (brand, name and variant, normalised) starts with the query, then the others, each group by that text.' }),
  })
  .openapi('ProductSearch')

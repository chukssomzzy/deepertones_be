import { z } from '@hono/zod-openapi'
import { BUDGET_BANDS } from '../catalog/catalog.vocabulary'

// Both are plain text here (with a length cap, so nothing silly reaches the service), so that a country or band nobody serves is the service's 400
// `UNKNOWN_COUNTRY` / `UNKNOWN_BUDGET_BAND`, which says which of the two it was, and not a generic `VALIDATION_FAILED`.
export const SetShoppingBody = z
  .strictObject({
    country: z.string().min(1).max(8).openapi({
      description: 'The country the user shops in, as its two-letter code in the catalog\'s Countries tab. A code that is not there, or is retired, is 400 `UNKNOWN_COUNTRY`.',
      example: 'NG',
    }),
    budgetBand: z.string().min(1).max(16).optional().openapi({
      description: `How much the user is happy to spend on a product: ${BUDGET_BANDS.map((band) => `\`${band}\``).join(', ')}. The bands are per country, each in its own money. Leave it out to have no budget band, which also takes back a band saved earlier. Anything else is 400 \`UNKNOWN_BUDGET_BAND\`.`,
      example: 'mid',
    }),
  })
  .openapi('SetShoppingBody')

export const ShoppingResponse = z
  .object({
    country: z.string().min(1).max(8).openapi({ example: 'NG' }),
    budgetBand: z.enum(BUDGET_BANDS).nullable().openapi({ description: 'Null when the user gave none.' }),
    updatedAt: z.string().openapi({ format: 'date-time', description: 'When the country and band were last saved.' }),
  })
  .openapi('Shopping')

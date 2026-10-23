import type { z } from '@hono/zod-openapi'
import type { ShoppingResponse } from './recommendations.schemas'
import type { ShoppingView } from './recommendations.types'

export const toShoppingResponse = ({ country, budgetBand, updatedAt }: ShoppingView): z.infer<typeof ShoppingResponse> => ({
  country,
  budgetBand,
  updatedAt: updatedAt.toISOString(),
})

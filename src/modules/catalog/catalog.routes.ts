import { defineRoute, errorResponses, ok, openapiApp, success } from '../../lib/openapi'
import { rateLimit } from '../../middleware/rate-limit'
import { signedIn } from '../../middleware/signed-in'
import { toProductSearchResponse } from './catalog.presenter'
import { ProductSearchResponse, SearchProductsQuery } from './catalog.schemas'

const searchProducts = defineRoute({
  method: 'get',
  path: '/search',
  operationId: 'searchProducts',
  tags: ['Products'],
  summary: 'Search the catalog by what the user types',
  description:
    'Finds named products whose brand, name or variant contain the query (or one of their other spellings), as the user types. No model is called. ' +
    'Pick a result with `POST /api/v1/scans/products/{scanId}/items/{itemId}/identification`. Unnamed products are never returned.',
  security: [{ bearerAuth: [] }],
  // The address limit counts every caller, signedIn turns the unsigned away before the query is validated, then the user limit.
  middleware: [rateLimit('PRODUCT_SEARCH_IP_LIMITER', 'ip'), signedIn(), rateLimit('PRODUCT_SEARCH_USER_LIMITER', 'user')],
  request: { query: SearchProductsQuery },
  responses: { 200: success(ProductSearchResponse, 'The matching products'), ...errorResponses(401, 429) },
})

export const productRoutes = openapiApp().openapi(searchProducts, async (c) => {
  const products = await c.var.services.catalog.search(c.req.valid('query').q)
  return ok(c, toProductSearchResponse(products), 'Products found')
})

import { defineRoute, errorResponses, jsonBody, ok, openapiApp, success } from '../../lib/openapi'
import { rateLimit } from '../../middleware/rate-limit'
import { signedIn } from '../../middleware/signed-in'
import { toShoppingResponse } from './recommendations.presenter'
import { SetShoppingBody, ShoppingResponse } from './recommendations.schemas'

const bearer = [{ bearerAuth: [] }]

const setShopping = defineRoute({
  method: 'put',
  path: '/shopping',
  operationId: 'setShopping',
  tags: ['Recommendations'],
  summary: 'Say which country you shop in and what you can spend',
  description:
    'Guests included. Send `{ country, budgetBand? }`: the country is a two-letter code from the catalog\'s Countries tab (400 `UNKNOWN_COUNTRY` for one that is not there or is retired), ' +
    'and the band is `low`, `mid` or `high` (400 `UNKNOWN_BUDGET_BAND` for anything else), each band set per country in that country\'s own money. Leave the band out to have none. ' +
    'Every change is kept with its date and the newest is the current one, so saving the country alone takes a band back. ' +
    'Each change counts against a per-address and a per-user limit: 429 `RATE_LIMITED` with `Retry-After`.',
  security: bearer,
  // In this order, as for the goal route: the address limit counts every caller, signedIn turns the unsigned away before the body is read,
  // and the user limit comes last.
  middleware: [rateLimit('SHOPPING_SET_IP_LIMITER', 'ip'), signedIn(), rateLimit('SHOPPING_SET_USER_LIMITER', 'user')],
  request: { body: jsonBody(SetShoppingBody) },
  responses: { 200: success(ShoppingResponse, 'The country and band as they are now'), ...errorResponses(401, 429) },
})

const getShopping = defineRoute({
  method: 'get',
  path: '/shopping',
  operationId: 'getShopping',
  tags: ['Recommendations'],
  summary: 'The country and budget band this profile shops with',
  description: 'The same view PUT answers. 404 `SHOPPING_NOT_SET` until the profile has saved a country: the app then suggests the phone\'s region and asks once.',
  security: bearer,
  responses: { 200: success(ShoppingResponse, 'The current shopping country and band'), ...errorResponses(401, 404) },
})

export const recommendationsRoutes = openapiApp()
  .openapi(setShopping, async (c) => ok(c, toShoppingResponse(await c.var.services.recommendations.setShopping(c.req.valid('json'))), 'Shopping saved'))
  .openapi(getShopping, async (c) => ok(c, toShoppingResponse(await c.var.services.recommendations.currentShopping()), 'Shopping'))

import { bodyLimit } from 'hono/body-limit'
import { defineRoute, errorResponses, imageResponse, jsonBody, multipartBody, ok, openapiApp, sseResponse, success } from '../../lib/openapi'
import { FALLBACK_IP, rateLimit } from '../../middleware/rate-limit'
import { signedIn } from '../../middleware/signed-in'
import { toProductImage, toScanItemResponse, toScanResponse } from './scans.presenter'
import { BackPhotoBody, ConfirmProductBody, CreateScanBody, CreateShelfScanBody, IdentifyProductBody, ItemParams, NoLabelBody, PhotoLinkParams, ScanItemResponse, RetakeBody, ScanParams, ScanResponse } from './scans.schemas'
import { SCAN_POLICY } from './scans.service'

const bearer = [{ bearerAuth: [] }]

// Room for the multipart framing around the photos. bodyLimit runs before the form is read, so an oversized upload is never buffered.
const FRAMING_BYTES = 1_000_000
const MAX_SCAN_BODY_BYTES = SCAN_POLICY.maxPhotosPerScan * SCAN_POLICY.maxPhotoBytes + FRAMING_BYTES
const MAX_SHELF_BODY_BYTES = SCAN_POLICY.maxShelfPhotos * SCAN_POLICY.maxPhotoBytes + FRAMING_BYTES
const MAX_BACK_PHOTO_BODY_BYTES = SCAN_POLICY.maxPhotoBytes + FRAMING_BYTES
const MAX_RETAKE_BODY_BYTES = SCAN_POLICY.maxPhotoBytes + FRAMING_BYTES

const createScan = defineRoute({
  method: 'post',
  path: '/',
  operationId: 'createProductScan',
  tags: ['Product scans'],
  summary: 'Start a product scan from 1 to 10 photos',
  description:
    'Multipart, one `photos` part per photo. Each photo becomes an item that is recognised in the background: poll `GET /api/v1/scans/products/{scanId}` for progress. ' +
    'One bad photo refuses the whole scan. Counts toward a daily limit of 30 photos per user and 100 per address (429 SCAN_DAILY_LIMIT).',
  security: bearer,
  // In this order: the address limit counts every caller, signedIn turns away the unsigned before anything is parsed, the user limit
  // needs a user, and bodyLimit comes last because only a signed-in caller is worth reading a body for.
  middleware: [
    rateLimit('SCAN_CREATE_IP_LIMITER', 'ip'),
    signedIn(),
    rateLimit('SCAN_CREATE_USER_LIMITER', 'user'),
    bodyLimit({ maxSize: MAX_SCAN_BODY_BYTES }),
  ],
  request: { body: multipartBody(CreateScanBody) },
  responses: { 202: success(ScanResponse, 'The scan, with every item recognising'), ...errorResponses(401, 413, 429) },
})

const createShelfScan = defineRoute({
  method: 'post',
  path: '/shelf',
  operationId: 'createShelfScan',
  tags: ['Product scans'],
  summary: 'Start a product scan from 1 to 3 photos of a shelf',
  description:
    'Multipart, one `photos` part per photo. Each photo is read in the background for up to 5 products, each of which becomes an item beside the others from its photo; ' +
    'a scan holds at most 20 items, and the rest are counted in the photo\'s `skipped`. Each product read counts against the daily limit (30 per user and 100 per address, 429 SCAN_DAILY_LIMIT ' +
    'when the photos alone would pass it; products left out for it are counted in `skipped.dailyLimit`). The response is the scan with one `recognising` item per photo: follow it with ' +
    '`GET /api/v1/scans/products/{scanId}/events` or poll `GET /api/v1/scans/products/{scanId}`, whose `photos` say how each photo went. One bad photo refuses the whole scan.',
  security: bearer,
  // The order and the reasons are createScan's; the limiters are the shelf route's own so that neither route spends the other's allowance.
  middleware: [
    rateLimit('SCAN_SHELF_IP_LIMITER', 'ip'),
    signedIn(),
    rateLimit('SCAN_SHELF_USER_LIMITER', 'user'),
    bodyLimit({ maxSize: MAX_SHELF_BODY_BYTES }),
  ],
  request: { body: multipartBody(CreateShelfScanBody) },
  responses: { 202: success(ScanResponse, 'The scan, with one recognising item per photo'), ...errorResponses(401, 413, 429) },
})

const getScan = defineRoute({
  method: 'get',
  path: '/{scanId}',
  operationId: 'getProductScan',
  tags: ['Product scans'],
  summary: 'A product scan and where each of its items has got to',
  description: 'Another user\'s scan is 404, the same as one that does not exist.',
  security: bearer,
  request: { params: ScanParams },
  responses: { 200: success(ScanResponse, 'The scan'), ...errorResponses(401, 404) },
})

const watchScan = defineRoute({
  method: 'get',
  path: '/{scanId}/events',
  operationId: 'watchProductScan',
  tags: ['Product scans'],
  summary: 'Follow a product scan live, as server-sent events',
  description:
    'A `text/event-stream`, not the usual envelope (errors before the stream starts still are). Frames: `snapshot` first, whose data is the scan exactly as ' +
    '`GET /api/v1/scans/products/{scanId}` returns it; then, on a shelf scan, one `photo` for each photo as it is read (state and `skipped` counts, as that response shows them), always before the `item` events of its products; then one `item` per change, whose data is the item as that response shows it; then `done` (data `{}`) once every item is ' +
    '`ready`, `rejected`, `failed` or `unidentified`, after which the server closes the stream. A scan that is already finished gets `snapshot` and `done` at once. ' +
    'A `: ping` comment arrives every 20 seconds while nothing else does. The server closes a stream 10 minutes after it opened; reconnect to carry on, ' +
    'the new `snapshot` is the current state. Send the bearer token as for every other route, which a browser `EventSource` cannot: use `fetch` and read the body. ' +
    'Another user\'s scan is 404, the same as one that does not exist.',
  security: bearer,
  request: { params: ScanParams },
  responses: { 200: sseResponse('The event stream'), ...errorResponses(401, 404) },
})

const confirmItem = defineRoute({
  method: 'post',
  path: '/{scanId}/items/{itemId}/confirmation',
  operationId: 'confirmProductScanItem',
  tags: ['Product scans'],
  summary: 'Correct what a doubtful photo was read as',
  description: 'For an item in `needs-confirmation`. The item goes on to matching with the product given.',
  security: bearer,
  request: { params: ItemParams, body: jsonBody(ConfirmProductBody) },
  responses: { 202: success(ScanItemResponse, 'The item, now matching'), ...errorResponses(401, 404, 409) },
})

const addBackPhoto = defineRoute({
  method: 'post',
  path: '/{scanId}/items/{itemId}/back-photo',
  operationId: 'addProductScanItemBackPhoto',
  tags: ['Product scans'],
  summary: 'Send a photo of the ingredient list',
  description: 'For an item in `needs-back-photo`, or in `needs-identification` (the back then identifies the product). Multipart with one `photo` part. Counts toward the same daily limits as a front photo.',
  security: bearer,
  middleware: [
    rateLimit('SCAN_BACK_PHOTO_IP_LIMITER', 'ip'),
    signedIn(),
    rateLimit('SCAN_BACK_PHOTO_USER_LIMITER', 'user'),
    bodyLimit({ maxSize: MAX_BACK_PHOTO_BODY_BYTES }),
  ],
  request: { params: ItemParams, body: multipartBody(BackPhotoBody) },
  responses: { 202: success(ScanItemResponse, 'The item, now reading the label'), ...errorResponses(401, 404, 409, 413, 429) },
})

const retakeItem = defineRoute({
  method: 'post',
  path: '/{scanId}/items/{itemId}/retake',
  operationId: 'retakeProductScanItem',
  tags: ['Product scans'],
  summary: 'Send the front photo again',
  description:
    'For an item in `needs-retake`. Multipart with one `photo` part. Counts toward the same daily limits as a front photo. ' +
    'An item is sent at most 3 front photos: when the 3rd cannot be read it moves to `needs-identification` instead.',
  security: bearer,
  middleware: [
    rateLimit('SCAN_RETAKE_IP_LIMITER', 'ip'),
    signedIn(),
    rateLimit('SCAN_RETAKE_USER_LIMITER', 'user'),
    bodyLimit({ maxSize: MAX_RETAKE_BODY_BYTES }),
  ],
  request: { params: ItemParams, body: multipartBody(RetakeBody) },
  responses: { 202: success(ScanItemResponse, 'The item, recognising the new photo'), ...errorResponses(401, 404, 409, 413, 429) },
})

const identifyItem = defineRoute({
  method: 'post',
  path: '/{scanId}/items/{itemId}/identification',
  operationId: 'identifyProductScanItem',
  tags: ['Product scans'],
  summary: 'Name the product of an item whose photo could not be read',
  description:
    'For an item in `needs-retake` or `needs-identification`. Send exactly one of `productId` (picked from `GET /api/v1/products/search`; no model is called) ' +
    'or `text` (a name the user typed, which is split into brand, name and variant by a model: 400 `NOT_A_PRODUCT_NAME` when it is not a product\'s name, ' +
    '503 `AI_UNAVAILABLE` when the model is unavailable). The item goes on to matching, researching, analysing or ready. ' +
    'It sends no photo, so no photo quota or retake is used.',
  security: bearer,
  // In this order, as for the photo routes: the address limit counts every caller, signedIn turns the unsigned away before the body is read,
  // and the user limit comes before any model is called.
  middleware: [rateLimit('SCAN_IDENTIFY_IP_LIMITER', 'ip'), signedIn(), rateLimit('SCAN_IDENTIFY_USER_LIMITER', 'user')],
  request: { params: ItemParams, body: jsonBody(IdentifyProductBody) },
  responses: { 202: success(ScanItemResponse, 'The item, now on its way'), ...errorResponses(401, 404, 409, 429, 503) },
})

const noLabelItem = defineRoute({
  method: 'post',
  path: '/{scanId}/items/{itemId}/no-label',
  operationId: 'markProductScanItemNoLabel',
  tags: ['Product scans'],
  summary: 'Say a product has no label to read',
  description:
    'For an item in `needs-identification` (its 3rd front photo could not be read), and no other state: 409 `ITEM_NOT_AWAITING_NO_LABEL`. ' +
    'Send where the product came from, what it is used for and for how long (fixed words), and optionally a short `description` (400 `INVALID_PRODUCT_TEXT` when it is over 200 characters or carries a link, markup or hidden character). ' +
    'The item ends as `unidentified`, which is final, with `noLabel` holding the answers and the cautions for a product of unknown contents. ' +
    'It sends no photo and calls no model, so no photo quota or retake is used.',
  security: bearer,
  // In this order, as for the identification route: the address limit counts every caller, signedIn turns the unsigned away before the body is read,
  // and the user limit comes last.
  middleware: [rateLimit('SCAN_NO_LABEL_IP_LIMITER', 'ip'), signedIn(), rateLimit('SCAN_NO_LABEL_USER_LIMITER', 'user')],
  request: { params: ItemParams, body: jsonBody(NoLabelBody) },
  responses: { 202: success(ScanItemResponse, 'The item, now unidentified'), ...errorResponses(401, 404, 409, 429) },
})

const getPhoto = defineRoute({
  method: 'get',
  path: '/photos/{token}',
  operationId: 'getProductScanPhoto',
  tags: ['Product scans'],
  summary: 'The photo a link from a product scan opens',
  description:
    'Public: the signed link is the credential, and it works for 5 minutes for whoever holds it. Any Authorization header is ignored. ' +
    'A link that is malformed, tampered with, expired or to a photo since deleted is 404 PHOTO_NOT_FOUND.',
  security: [],
  request: { params: PhotoLinkParams },
  responses: { 200: imageResponse('The photo'), ...errorResponses(404) },
})

// The client address is Cloudflare's own header, as in rateLimit. The service hashes it for the daily per-address quota.

export const scanRoutes = openapiApp()
  .openapi(createScan, async (c) => {
    const { photos } = c.req.valid('form')
    const scan = await c.var.services.scans.create({
      photos: await Promise.all(photos.map(toProductImage)),
      clientIp: c.req.header('cf-connecting-ip') ?? FALLBACK_IP,
    })
    return ok(c, toScanResponse(scan), 'Scan started', 202)
  })
  .openapi(createShelfScan, async (c) => {
    const { photos } = c.req.valid('form')
    const scan = await c.var.services.scans.createShelf({
      photos: await Promise.all(photos.map(toProductImage)),
      clientIp: c.req.header('cf-connecting-ip') ?? FALLBACK_IP,
    })
    return ok(c, toScanResponse(scan), 'Shelf scan started', 202)
  })
  .openapi(getScan, async (c) => ok(c, toScanResponse(await c.var.services.scans.getScan(c.req.valid('param').scanId)), 'Scan found'))
  .openapi(watchScan, async (c) => c.var.services.scans.watch(c.req.valid('param').scanId))
  .openapi(confirmItem, async (c) => {
    const { scanId, itemId } = c.req.valid('param')
    const item = await c.var.services.scans.confirm(scanId, itemId, c.req.valid('json'))
    return ok(c, toScanItemResponse(item), 'Product confirmed', 202)
  })
  .openapi(addBackPhoto, async (c) => {
    const { scanId, itemId } = c.req.valid('param')
    const photo = await toProductImage(c.req.valid('form').photo)
    const item = await c.var.services.scans.addBackPhoto(scanId, itemId, photo, c.req.header('cf-connecting-ip') ?? FALLBACK_IP)
    return ok(c, toScanItemResponse(item), 'Back photo received', 202)
  })
  .openapi(retakeItem, async (c) => {
    const { scanId, itemId } = c.req.valid('param')
    const photo = await toProductImage(c.req.valid('form').photo)
    const item = await c.var.services.scans.retake(scanId, itemId, photo, c.req.header('cf-connecting-ip') ?? FALLBACK_IP)
    return ok(c, toScanItemResponse(item), 'Retaken photo received', 202)
  })
  .openapi(identifyItem, async (c) => {
    const { scanId, itemId } = c.req.valid('param')
    const item = await c.var.services.scans.identifyByName(scanId, itemId, c.req.valid('json'))
    return ok(c, toScanItemResponse(item), 'Product identified', 202)
  })
  .openapi(noLabelItem, async (c) => {
    const { scanId, itemId } = c.req.valid('param')
    const item = await c.var.services.scans.noLabel(scanId, itemId, c.req.valid('json'))
    return ok(c, toScanItemResponse(item), 'Marked as having no label', 202)
  })
  .openapi(getPhoto, async (c) => {
    const photo = await c.var.services.scans.photoForLink(c.req.valid('param').token)
    return new Response(photo.bytes, { headers: { 'Content-Type': photo.mediaType, 'Cache-Control': 'private, no-store' } })
  })

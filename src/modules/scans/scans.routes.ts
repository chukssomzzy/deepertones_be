import { bodyLimit } from 'hono/body-limit'
import { defineRoute, errorResponses, imageResponse, jsonBody, multipartBody, ok, openapiApp, sseResponse, success } from '../../lib/openapi'
import { rateLimit } from '../../middleware/rate-limit'
import { signedIn } from '../../middleware/signed-in'
import { toProductImage, toScanItemResponse, toScanResponse } from './scans.presenter'
import { BackPhotoBody, ConfirmProductBody, CreateScanBody, ItemParams, PhotoLinkParams, ScanItemResponse, RetakeBody, ScanParams, ScanResponse } from './scans.schemas'
import { SCAN_POLICY } from './scans.service'

const bearer = [{ bearerAuth: [] }]

// Room for the multipart framing around the photos. bodyLimit runs before the form is read, so an oversized upload is never buffered.
const FRAMING_BYTES = 1_000_000
const MAX_SCAN_BODY_BYTES = SCAN_POLICY.maxPhotosPerScan * SCAN_POLICY.maxPhotoBytes + FRAMING_BYTES
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
    '`GET /api/v1/scans/products/{scanId}` returns it; then one `item` per change, whose data is the item as that response shows it; then `done` (data `{}`) once every item is ' +
    '`ready`, `rejected` or `failed`, after which the server closes the stream. A scan that is already finished gets `snapshot` and `done` at once. ' +
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
  description: 'For an item in `needs-back-photo`. Multipart with one `photo` part. Counts toward the same daily limits as a front photo.',
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
const FALLBACK_IP = 'unknown'

export const scanRoutes = openapiApp()
  .openapi(createScan, async (c) => {
    const { photos } = c.req.valid('form')
    const scan = await c.var.services.scans.create({
      photos: await Promise.all(photos.map(toProductImage)),
      clientIp: c.req.header('cf-connecting-ip') ?? FALLBACK_IP,
    })
    return ok(c, toScanResponse(scan), 'Scan started', 202)
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
  .openapi(getPhoto, async (c) => {
    const photo = await c.var.services.scans.photoForLink(c.req.valid('param').token)
    return new Response(photo.bytes, { headers: { 'Content-Type': photo.mediaType, 'Cache-Control': 'private, no-store' } })
  })

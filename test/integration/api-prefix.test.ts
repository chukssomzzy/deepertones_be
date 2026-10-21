import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

// Every API route lives under /api/v1; only /health, /docs and /openapi.json stay at the root. The app has not shipped, so the
// old unversioned paths are simply gone: they answer the standard 404, not a redirect.
const fetchWorker = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`http://deepertones.test${path}`, init))

const SCAN_ID = '00000000-0000-4000-8000-000000000001'
const ITEM_ID = '00000000-0000-4000-8000-000000000002'

type Operation = { operationId?: string; summary?: string; tags?: string[] }
type Document = { paths: Record<string, Record<string, Operation>> }
const documentOf = async () => {
  const res = await fetchWorker('/openapi.json')
  expect(res.status).toBe(200)
  return (await res.json()) as Document
}

describe('the unversioned root', () => {
  it('still serves GET /health', async () => {
    const res = await fetchWorker('/health')

    expect(res.status).toBe(200)
  })

  it('does not serve /health under the API prefix', async () => {
    const res = await fetchWorker('/api/v1/health')

    expect(res.status).toBe(404)
  })

  it('still serves /docs and /openapi.json', async () => {
    expect((await fetchWorker('/docs')).status).toBe(200)
    expect((await fetchWorker('/openapi.json')).status).toBe(200)
  })

  it('does not serve the docs under the API prefix', async () => {
    expect((await fetchWorker('/api/v1/docs')).status).toBe(404)
    expect((await fetchWorker('/api/v1/openapi.json')).status).toBe(404)
  })
})

describe('the old unversioned API paths', () => {
  const gone: [string, string][] = [
    ['POST', '/auth/anonymous'],
    ['POST', '/auth/refresh'],
    ['POST', '/auth/logout'],
    ['POST', '/auth/otp/send'],
    ['POST', '/auth/otp/verify'],
    ['GET', '/me'],
    ['POST', '/scans'],
    ['GET', '/scans/x'],
    ['GET', `/scans/${SCAN_ID}/events`],
    ['POST', `/scans/${SCAN_ID}/items/${ITEM_ID}/confirmation`],
    ['POST', `/scans/${SCAN_ID}/items/${ITEM_ID}/back-photo`],
    ['GET', '/scans/photos/x'],
    ['GET', '/products/search?q=serum'],
    ['GET', '/onboarding/content'],
    ['POST', '/scans/products'],
    ['GET', `/scans/products/${SCAN_ID}`],
  ]

  it.each(gone)('%s %s is a 404', async (method, path) => {
    const res = await fetchWorker(path, { method })

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ success: false, status: 404, error: { code: 'NOT_FOUND' } })
  })

  it('does not keep the scan routes at /api/v1/scans without "products"', async () => {
    expect((await fetchWorker(`/api/v1/scans/${SCAN_ID}`)).status).toBe(404)
    expect((await fetchWorker('/api/v1/scans', { method: 'POST' })).status).toBe(404)
    expect((await fetchWorker('/api/v1/scans/photos/x')).status).toBe(404)
  })
})

describe('the versioned API', () => {
  it('answers GET /api/v1/me without a token with 401 AUTH_REQUIRED', async () => {
    const res = await fetchWorker('/api/v1/me')

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ success: false, status: 401, error: { code: 'AUTH_REQUIRED' } })
  })

  it('answers GET /api/v1/products/search without a token with 401 AUTH_REQUIRED', async () => {
    const res = await fetchWorker('/api/v1/products/search?q=serum')

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ success: false, status: 401, error: { code: 'AUTH_REQUIRED' } })
  })

  it.each([
    ['GET', '/api/v1/me/face-consent'],
    ['PUT', '/api/v1/me/face-consent'],
    ['DELETE', '/api/v1/me/face-consent'],
    ['GET', '/api/v1/scans/faces'],
    ['GET', `/api/v1/scans/faces/${SCAN_ID}`],
    ['DELETE', `/api/v1/scans/faces/${SCAN_ID}`],
  ])('answers %s %s without a token with 401 AUTH_REQUIRED', async (method, path) => {
    const res = await fetchWorker(path, { method })

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ success: false, status: 401, error: { code: 'AUTH_REQUIRED' } })
  })

  it('answers GET /api/v1/scans/faces/photos/{token} without a token with 404 PHOTO_NOT_FOUND, not 401: the link is the credential', async () => {
    const res = await fetchWorker('/api/v1/scans/faces/photos/not-a-token')

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ success: false, status: 404, error: { code: 'PHOTO_NOT_FOUND' } })
  })

  it('answers GET /api/v1/scans/products/{scanId} without a token with 401 AUTH_REQUIRED', async () => {
    const res = await fetchWorker(`/api/v1/scans/products/${SCAN_ID}`)

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ success: false, status: 401, error: { code: 'AUTH_REQUIRED' } })
  })
})

describe('the OpenAPI document', () => {
  it('lists only /api/v1 paths, plus /health', async () => {
    const { paths } = await documentOf()

    const unversioned = Object.keys(paths).filter((path) => path !== '/health' && !path.startsWith('/api/v1/'))
    expect(unversioned).toEqual([])
    expect(paths['/health']?.get).toBeDefined()
  })

  it('lists every API route under its versioned path', async () => {
    const { paths } = await documentOf()

    const documented = Object.entries(paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`))
    expect(documented.sort()).toEqual(
      [
        'GET /health',
        'POST /api/v1/auth/anonymous',
        'POST /api/v1/auth/refresh',
        'POST /api/v1/auth/logout',
        'POST /api/v1/auth/otp/send',
        'POST /api/v1/auth/otp/verify',
        'GET /api/v1/me',
        'PUT /api/v1/me/push-token',
        'DELETE /api/v1/me/push-token',
        'GET /api/v1/me/notification-settings',
        'PATCH /api/v1/me/notification-settings',
        'PUT /api/v1/me/goal',
        'GET /api/v1/me/goal',
        'GET /api/v1/me/onboarding',
        'PUT /api/v1/me/safety',
        'GET /api/v1/me/safety',
        'PUT /api/v1/me/face-consent',
        'GET /api/v1/me/face-consent',
        'DELETE /api/v1/me/face-consent',
        'GET /api/v1/me/shelf',
        'DELETE /api/v1/me/shelf/{entryId}',
        'POST /api/v1/me/shelf',
        'POST /api/v1/scans/products',
        'POST /api/v1/scans/products/shelf',
        'GET /api/v1/scans/products/{scanId}',
        'GET /api/v1/scans/products/{scanId}/events',
        'POST /api/v1/scans/products/{scanId}/items/{itemId}/confirmation',
        'POST /api/v1/scans/products/{scanId}/items/{itemId}/back-photo',
        'POST /api/v1/scans/products/{scanId}/items/{itemId}/retake',
        'POST /api/v1/scans/products/{scanId}/items/{itemId}/identification',
        'POST /api/v1/scans/products/{scanId}/items/{itemId}/no-label',
        'GET /api/v1/scans/products/photos/{token}',
        'POST /api/v1/scans/faces',
        'GET /api/v1/scans/faces',
        'GET /api/v1/scans/faces/{id}',
        'DELETE /api/v1/scans/faces/{id}',
        'GET /api/v1/scans/faces/photos/{token}',
        'GET /api/v1/scans/faces/{id}/events',
        'POST /api/v1/scans/faces/{id}/retake',
        'POST /api/v1/webhooks/perfect-corp',
        'GET /api/v1/products/search',
        'GET /api/v1/onboarding/content',
      ].sort(),
    )
  })

  it('names the scan operations after the product scan, under the "Product scans" tag', async () => {
    const { paths } = await documentOf()
    const base = '/api/v1/scans/products'
    const operations = {
      createProductScan: paths[base]?.post,
      getProductScan: paths[`${base}/{scanId}`]?.get,
      watchProductScan: paths[`${base}/{scanId}/events`]?.get,
      confirmProductScanItem: paths[`${base}/{scanId}/items/{itemId}/confirmation`]?.post,
      addProductScanItemBackPhoto: paths[`${base}/{scanId}/items/{itemId}/back-photo`]?.post,
      retakeProductScanItem: paths[`${base}/{scanId}/items/{itemId}/retake`]?.post,
      identifyProductScanItem: paths[`${base}/{scanId}/items/{itemId}/identification`]?.post,
      markProductScanItemNoLabel: paths[`${base}/{scanId}/items/{itemId}/no-label`]?.post,
      getProductScanPhoto: paths[`${base}/photos/{token}`]?.get,
    }

    for (const [operationId, operation] of Object.entries(operations)) {
      expect(operation?.operationId, operationId).toBe(operationId)
      expect(operation?.tags, operationId).toEqual(['Product scans'])
    }
  })

  it('names the product search operation searchProducts, under the "Products" tag, with a summary', async () => {
    const { paths } = await documentOf()

    const search = paths['/api/v1/products/search']?.get

    expect(search?.operationId).toBe('searchProducts')
    expect(search?.tags).toEqual(['Products'])
    expect(search?.summary).toEqual(expect.any(String))
  })

  it('says "product scan" in the summaries that name a scan', async () => {
    const { paths } = await documentOf()
    const base = '/api/v1/scans/products'

    for (const summary of [
      paths[base]?.post?.summary,
      paths[`${base}/{scanId}`]?.get?.summary,
      paths[`${base}/{scanId}/events`]?.get?.summary,
      paths[`${base}/photos/{token}`]?.get?.summary,
    ]) {
      expect(summary).toMatch(/product scan/i)
    }
  })

  it('keeps no operationId from before the rename', async () => {
    const { paths } = await documentOf()

    const ids = Object.values(paths).flatMap((methods) => Object.values(methods).map((operation) => operation.operationId))
    for (const old of ['createScan', 'getScan', 'watchScan', 'confirmScanItem', 'addScanItemBackPhoto', 'getScanPhoto']) {
      expect(ids).not.toContain(old)
    }
  })
})

// The face scan routes (issue #112): paths, operation names, the one public route, and the error codes a client can meet, which the document
// carries in the operations' descriptions (the error responses are documented by status).
describe('the OpenAPI document: face scans', () => {
  type FaceOperation = Operation & { description?: string; security?: unknown[]; responses?: Record<string, { content?: Record<string, unknown> }> }
  type FaceDocument = { paths: Record<string, Record<string, FaceOperation>> }
  const faceDocumentOf = async () => (await documentOf()) as unknown as FaceDocument
  const FACES = '/api/v1/scans/faces'
  const CONSENT = '/api/v1/me/face-consent'

  it('names the face scan and consent operations, all under the "Face scans" tag, each with a summary', async () => {
    const { paths } = await faceDocumentOf()
    const operations = {
      setFaceConsent: paths[CONSENT]?.put,
      getFaceConsent: paths[CONSENT]?.get,
      withdrawFaceConsent: paths[CONSENT]?.delete,
      createFaceScan: paths[FACES]?.post,
      listFaceScans: paths[FACES]?.get,
      getFaceScan: paths[`${FACES}/{id}`]?.get,
      deleteFaceScan: paths[`${FACES}/{id}`]?.delete,
      getFaceScanPhoto: paths[`${FACES}/photos/{token}`]?.get,
    }

    for (const [operationId, operation] of Object.entries(operations)) {
      expect(operation?.operationId, operationId).toBe(operationId)
      expect(operation?.tags, operationId).toEqual(['Face scans'])
      expect(operation?.summary, operationId).toEqual(expect.any(String))
    }
  })

  it('leaves the product scan routes under "Product scans": face scans are a separate tag', async () => {
    const { paths } = await faceDocumentOf()

    expect(paths['/api/v1/scans/products']?.post?.tags).toEqual(['Product scans'])
  })

  it('documents the photo route as public (security: []), and every other face route as needing the bearer token', async () => {
    const { paths } = await faceDocumentOf()

    expect(paths[`${FACES}/photos/{token}`]?.get?.security).toEqual([])
    for (const operation of [paths[CONSENT]?.put, paths[CONSENT]?.get, paths[CONSENT]?.delete, paths[FACES]?.post, paths[FACES]?.get, paths[`${FACES}/{id}`]?.get, paths[`${FACES}/{id}`]?.delete]) {
      expect(operation?.security).toEqual([{ bearerAuth: [] }])
    }
  })

  it('documents the photo route as a JPEG with a 404, and creating a scan as a 202 with the errors a client meets', async () => {
    const { paths } = await faceDocumentOf()

    expect(Object.keys(paths[`${FACES}/photos/{token}`]?.get?.responses?.['200']?.content ?? {})).toContain('image/jpeg')
    expect(paths[`${FACES}/photos/{token}`]?.get?.responses).toHaveProperty('404')
    const create = paths[FACES]?.post?.responses ?? {}
    for (const status of ['202', '400', '401', '409', '413', '429']) expect(create, status).toHaveProperty(status)
  })

  it('documents the other face routes\' answers: consent 200 and 204, a scan 200 and 404, a delete 204 and 404', async () => {
    const { paths } = await faceDocumentOf()

    expect(paths[CONSENT]?.put?.responses).toHaveProperty('200')
    expect(paths[CONSENT]?.put?.responses).toHaveProperty('400')
    expect(paths[CONSENT]?.get?.responses).toHaveProperty('200')
    expect(paths[CONSENT]?.get?.responses).toHaveProperty('404')
    expect(paths[CONSENT]?.delete?.responses).toHaveProperty('204')
    expect(paths[`${FACES}/{id}`]?.get?.responses).toHaveProperty('200')
    expect(paths[`${FACES}/{id}`]?.get?.responses).toHaveProperty('404')
    expect(paths[`${FACES}/{id}`]?.delete?.responses).toHaveProperty('204')
    expect(paths[`${FACES}/{id}`]?.delete?.responses).toHaveProperty('404')
  })

  it('names the error codes in the descriptions that can answer with them', async () => {
    const { paths } = await faceDocumentOf()
    const descriptionOf = (operation: FaceOperation | undefined) => operation?.description ?? ''

    expect(descriptionOf(paths[FACES]?.post)).toContain('FACE_CONSENT_REQUIRED')
    expect(descriptionOf(paths[FACES]?.post)).toContain('FACE_SCAN_NOT_DUE')
    expect(descriptionOf(paths[FACES]?.post)).toContain('GOAL_REQUIRED')
    expect(descriptionOf(paths[FACES]?.post)).toContain('UNSUPPORTED_IMAGE')
    expect(descriptionOf(paths[`${FACES}/{id}`]?.get)).toContain('FACE_SCAN_NOT_FOUND')
    expect(descriptionOf(paths[`${FACES}/{id}`]?.delete)).toContain('FACE_SCAN_NOT_FOUND')
    expect(descriptionOf(paths[`${FACES}/photos/{token}`]?.get)).toContain('PHOTO_NOT_FOUND')
    expect(descriptionOf(paths[CONSENT]?.put)).toContain('FACE_CONSENT_VERSION_MISMATCH')
    expect(descriptionOf(paths[CONSENT]?.get)).toContain('FACE_CONSENT_NOT_FOUND')
  })
})

import { z } from '@hono/zod-openapi'
import { env } from 'cloudflare:workers'
import { requestId } from 'hono/request-id'
import { describe, expect, it } from 'vitest'
import { errorHandler } from './errors'
import { defineRoute, ErrorResponse, errorResponses, imageResponse, jsonBody, multipartBody, ok, openapiApp, sseResponse, success } from './openapi'

const echo = defineRoute({
  method: 'post',
  path: '/echo',
  operationId: 'echo',
  tags: ['Test'],
  request: { body: jsonBody(z.object({ name: z.string().min(1) })) },
  responses: { 200: success(z.object({ name: z.string() }), 'Echoed') },
})

const create = defineRoute({
  method: 'post',
  path: '/create',
  operationId: 'create',
  tags: ['Test'],
  responses: { 201: success(z.object({ id: z.string() }), 'Created') },
})

const accept = defineRoute({
  method: 'post',
  path: '/accept',
  operationId: 'accept',
  tags: ['Test'],
  responses: { 202: success(z.object({ job: z.string() }), 'Accepted') },
})

const bare = defineRoute({
  method: 'get',
  path: '/bare',
  operationId: 'bare',
  tags: ['Test'],
  responses: { 200: success(z.object({ name: z.string() }), 'Bare') },
})

const ping = defineRoute({
  method: 'get',
  path: '/ping',
  operationId: 'ping',
  tags: ['Test'],
  responses: { 204: { description: 'Pong' }, ...errorResponses(401, 404) },
})

// A throwaway app exercising the shared OpenAPI plumbing.
const app = openapiApp()
app.use(requestId())
app
  .openapi(echo, (c) => ok(c, { name: c.req.valid('json').name }, 'Echoed'))
  .openapi(create, (c) => ok(c, { id: 'abc' }, 'Created', 201))
  .openapi(accept, (c) => ok(c, { job: 'j1' }, 'Accepted', 202))
  .openapi(ping, (c) => c.body(null, 204))

// Compile-time only: a handler for a success() route must go through ok(), not return bare data.
export const neverMounted = () =>
  openapiApp().openapi(
    bare,
    // @ts-expect-error the body must be the success envelope, not the bare data
    (c) => c.json({ name: 'x' }, 200),
  )

app.onError(errorHandler)

const postEcho = (body: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
  app.request('/echo', { method: 'POST', body, headers }, env)

describe('request validation', () => {
  it('passes typed data through on valid input', async () => {
    const res = await postEcho(JSON.stringify({ name: 'deepertones' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      status: 200,
      message: 'Echoed',
      data: { name: 'deepertones' },
    })
  })

  it('sends the status given to ok() in both the HTTP status and the body', async () => {
    const res = await app.request('/create', { method: 'POST' }, env)

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ success: true, status: 201, message: 'Created', data: { id: 'abc' } })
  })

  it('sends 202 in both the HTTP status and the body', async () => {
    const res = await app.request('/accept', { method: 'POST' }, env)

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ success: true, status: 202, message: 'Accepted', data: { job: 'j1' } })
  })

  it('answers 204 with an empty body, not an envelope', async () => {
    const res = await app.request('/ping', {}, env)

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it('rejects invalid input with VALIDATION_FAILED and per-field details', async () => {
    const res = await postEcho(JSON.stringify({ name: '' }))

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      success: false,
      status: 400,
      message: 'Invalid json',
      error: { code: 'VALIDATION_FAILED', details: [{ path: 'name' }] },
    })
  })

  it('rejects a body that is not JSON with 415, in the standard error shape', async () => {
    const res = await postEcho('name=deepertones', { 'Content-Type': 'text/plain' })

    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({ success: false, status: 415, error: { code: 'HTTP_415' } })
  })
})

describe('defineRoute', () => {
  it('adds 400, 415 and 500 to a route that takes a body', () => {
    expect(Object.keys(echo.responses).sort()).toEqual(['200', '400', '415', '500'])
  })

  it('adds only 500 to a route without input, keeping the ones it declares', () => {
    expect(Object.keys(ping.responses).sort()).toEqual(['204', '401', '404', '500'])
  })
})

// OpenAPI 3.1 may express z.literal as `const` or as a one-value `enum`.
const literalOf = (schema: unknown) => {
  const { const: value, enum: values } = schema as { const?: unknown; enum?: unknown[] }
  return values ? values[0] : value
}

describe('the generated document', () => {
  const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'test', version: '0' } })

  it('shares one ErrorResponse component across routes', () => {
    expect(doc.components?.schemas).toHaveProperty('ErrorResponse')
    expect(JSON.stringify(doc.paths?.['/ping']?.get?.responses?.['404'])).toContain(
      '#/components/schemas/ErrorResponse',
    )
  })

  it('describes the error envelope in ErrorResponse', () => {
    const schema = doc.components?.schemas?.ErrorResponse as { properties: Record<string, unknown> }

    expect(Object.keys(schema.properties).sort()).toEqual(['error', 'message', 'status', 'success'])
    expect(literalOf(schema.properties.success)).toBe(false)
    expect(schema.properties.status).toMatchObject({ type: 'integer' })
  })

  it('describes the success envelope around the declared data schema', () => {
    const schema = (
      doc.paths?.['/echo']?.post?.responses?.['200'] as {
        content: { 'application/json': { schema: { properties: Record<string, unknown> } } }
      }
    ).content['application/json'].schema

    expect(Object.keys(schema.properties).sort()).toEqual(['data', 'message', 'status', 'success'])
    expect(literalOf(schema.properties.success)).toBe(true)
    expect(schema.properties.status).toMatchObject({ type: 'integer' })
  })

  it('carries each operationId', () => {
    expect(doc.paths?.['/echo']?.post?.operationId).toBe('echo')
  })
})

// --- multipart bodies, image and event-stream responses, and the 413 / 415 texts ---
// Routes for these are built inside each test, not at the top of the file: until the helpers exist, only these tests fail.

const asBinary = () => z.instanceof(File).openapi({ type: 'string', format: 'binary' })
const UploadBody = () => z.object({ photo: asBinary() })

/** A throwaway app with an upload route, an image route and an event-stream route. */
const buildMediaApp = () => {
  const upload = defineRoute({
    method: 'post',
    path: '/upload',
    operationId: 'upload',
    tags: ['Test'],
    request: { body: multipartBody(UploadBody()) },
    responses: { 200: success(z.object({ name: z.string(), size: z.number() }), 'Received') },
  })
  const picture = defineRoute({
    method: 'get',
    path: '/picture',
    operationId: 'picture',
    tags: ['Test'],
    responses: { 200: imageResponse('The picture'), ...errorResponses(404) },
  })
  const events = defineRoute({
    method: 'get',
    path: '/events',
    operationId: 'events',
    tags: ['Test'],
    responses: { 200: sseResponse('Progress, as it happens') },
  })
  const mediaApp = openapiApp()
  mediaApp.use(requestId())
  mediaApp
    .openapi(upload, (c) => {
      const { photo } = c.req.valid('form')
      return ok(c, { name: photo.name, size: photo.size }, 'Received')
    })
    .openapi(picture, () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/webp' } }))
    .openapi(events, () => new Response('event: ping\ndata: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  mediaApp.onError(errorHandler)
  return { upload, picture, events, mediaApp }
}

const schemaOf = (content: Record<string, { schema?: unknown }> | undefined, type: string) => content?.[type]?.schema

describe('multipartBody', () => {
  it('is a required multipart/form-data body around the schema', () => {
    const schema = UploadBody()

    const body = multipartBody(schema)

    expect(body).toEqual({ required: true, content: { 'multipart/form-data': { schema } } })
    expect(body.content['multipart/form-data']?.schema).toBe(schema)
  })

  it('hands the handler a typed File from a form upload', async () => {
    const { mediaApp } = buildMediaApp()
    const form = new FormData()
    form.append('photo', new File([new Uint8Array(5)], 'front.jpg', { type: 'image/jpeg' }))

    const res = await mediaApp.request('/upload', { method: 'POST', body: form }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, status: 200, data: { name: 'front.jpg', size: 5 } })
  })

  it('rejects a missing file with VALIDATION_FAILED and the field in the details', async () => {
    const { mediaApp } = buildMediaApp()

    const res = await mediaApp.request('/upload', { method: 'POST', body: new FormData() }, env)

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ success: false, status: 400, error: { code: 'VALIDATION_FAILED', details: [{ path: 'photo' }] } })
  })

  it('rejects a JSON body with 415, in the standard error shape', async () => {
    const { mediaApp } = buildMediaApp()

    const res = await mediaApp.request('/upload', { method: 'POST', body: JSON.stringify({ photo: 'x' }), headers: { 'Content-Type': 'application/json' } }, env)

    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({ success: false, status: 415, error: { code: 'HTTP_415' } })
  })

  it('gives its route the same default errors as a JSON body route: 400, 415 and 500', () => {
    const { upload } = buildMediaApp()

    expect(Object.keys(upload.responses).sort()).toEqual(['200', '400', '415', '500'])
  })

  it('is documented as a required multipart/form-data request body with a binary file field', () => {
    const { mediaApp } = buildMediaApp()
    const doc = mediaApp.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'test', version: '0' } })

    const body = doc.paths?.['/upload']?.post?.requestBody as { required?: boolean; content: Record<string, { schema: { properties: Record<string, unknown> } }> }

    expect(body.required).toBe(true)
    expect(Object.keys(body.content)).toEqual(['multipart/form-data'])
    expect(body.content['multipart/form-data']?.schema.properties.photo).toMatchObject({ type: 'string', format: 'binary' })
  })
})

describe('imageResponse', () => {
  it('declares exactly image/jpeg and image/webp, each as binary content, with the description', () => {
    const response = imageResponse('The photo')

    expect(response.description).toBe('The photo')
    expect(Object.keys(response.content).sort()).toEqual(['image/jpeg', 'image/webp'])
  })

  it('is documented as binary strings, not as the JSON envelope', () => {
    const { mediaApp } = buildMediaApp()
    const doc = mediaApp.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'test', version: '0' } })

    const ok200 = doc.paths?.['/picture']?.get?.responses?.['200'] as { description: string; content: Record<string, { schema?: unknown }> }

    expect(ok200.description).toBe('The picture')
    expect(Object.keys(ok200.content).sort()).toEqual(['image/jpeg', 'image/webp'])
    expect(schemaOf(ok200.content, 'image/jpeg')).toMatchObject({ type: 'string', format: 'binary' })
    expect(schemaOf(ok200.content, 'image/webp')).toMatchObject({ type: 'string', format: 'binary' })
  })

  it('lets a route answer with image bytes and still answer an error in the envelope', async () => {
    const { mediaApp } = buildMediaApp()

    const res = await mediaApp.request('/picture', {}, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/webp')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('sseResponse', () => {
  it('declares text/event-stream, and only that, with the description', () => {
    const response = sseResponse('Progress, as it happens')

    expect(response.description).toBe('Progress, as it happens')
    expect(Object.keys(response.content)).toEqual(['text/event-stream'])
  })

  it('is documented as a string stream, not as the JSON envelope', () => {
    const { mediaApp } = buildMediaApp()
    const doc = mediaApp.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'test', version: '0' } })

    const ok200 = doc.paths?.['/events']?.get?.responses?.['200'] as { content: Record<string, { schema?: unknown }> }

    expect(Object.keys(ok200.content)).toEqual(['text/event-stream'])
    expect(schemaOf(ok200.content, 'text/event-stream')).toMatchObject({ type: 'string' })
  })

  it('lets a route answer with an event stream', async () => {
    const { mediaApp } = buildMediaApp()

    const res = await mediaApp.request('/events', {}, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')
    expect(await res.text()).toBe('event: ping\ndata: {}\n\n')
  })
})

describe('error descriptions', () => {
  const describedAs = (status: 413 | 415) => (errorResponses(status) as Record<number, { description: string }>)[status]?.description

  it('describes 413 as "Request body too large"', () => {
    expect(describedAs(413)).toBe('Request body too large')
  })

  it('describes 413 in the error envelope, like every other error status', () => {
    const response = (errorResponses(413) as Record<number, { content: Record<string, { schema: unknown }> }>)[413]

    expect(Object.keys(response?.content ?? {})).toEqual(['application/json'])
    expect(response?.content['application/json']?.schema).toBe(ErrorResponse)
  })

  it('describes 415 as an unsupported Content-Type for the route, no longer as "must be application/json"', () => {
    const text = describedAs(415)

    expect(text).toMatch(/content-type/i)
    expect(text).toMatch(/not supported|isn't supported|unsupported/i)
    expect(text).not.toMatch(/must be application\/json/i)
  })

  it('shows the new 415 text on a multipart route in the generated document', () => {
    const { mediaApp } = buildMediaApp()
    const doc = mediaApp.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'test', version: '0' } })

    const description = (doc.paths?.['/upload']?.post?.responses?.['415'] as { description: string }).description

    expect(description).not.toMatch(/must be application\/json/i)
    expect(description).toMatch(/content-type/i)
  })

  it('lists 413 on a route that asks for it', () => {
    const route = defineRoute({
      method: 'post',
      path: '/big',
      operationId: 'big',
      tags: ['Test'],
      request: { body: multipartBody(UploadBody()) },
      responses: { 200: success(z.object({}), 'Fine'), ...errorResponses(413) },
    })

    expect(Object.keys(route.responses).sort()).toEqual(['200', '400', '413', '415', '500'])
  })
})

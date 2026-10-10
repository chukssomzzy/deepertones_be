import { z } from '@hono/zod-openapi'
import { env } from 'cloudflare:workers'
import { requestId } from 'hono/request-id'
import { describe, expect, it } from 'vitest'
import { errorHandler } from './errors'
import { defineRoute, errorResponses, jsonBody, ok, openapiApp, success } from './openapi'

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

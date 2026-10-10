import { z } from '@hono/zod-openapi'
import { env } from 'cloudflare:workers'
import { requestId } from 'hono/request-id'
import { describe, expect, it } from 'vitest'
import { errorHandler } from './errors'
import { defineRoute, errorResponses, json, jsonBody, openapiApp } from './openapi'

const echo = defineRoute({
  method: 'post',
  path: '/echo',
  operationId: 'echo',
  tags: ['Test'],
  request: { body: jsonBody(z.object({ name: z.string().min(1) })) },
  responses: { 200: json(z.object({ name: z.string() }), 'Echoed') },
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
  .openapi(echo, (c) => c.json({ name: c.req.valid('json').name }, 200))
  .openapi(ping, (c) => c.body(null, 204))

app.onError(errorHandler)

const postEcho = (body: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
  app.request('/echo', { method: 'POST', body, headers }, env)

describe('request validation', () => {
  it('passes typed data through on valid input', async () => {
    const res = await postEcho(JSON.stringify({ name: 'deepertones' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'deepertones' })
  })

  it('rejects invalid input with VALIDATION_FAILED and per-field details', async () => {
    const res = await postEcho(JSON.stringify({ name: '' }))

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid json', details: [{ path: 'name' }] },
    })
  })

  it('rejects a body that is not JSON with 415, in the standard error shape', async () => {
    const res = await postEcho('name=deepertones', { 'Content-Type': 'text/plain' })

    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({ error: { code: 'HTTP_415' } })
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

describe('the generated document', () => {
  const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'test', version: '0' } })

  it('shares one ErrorResponse component across routes', () => {
    expect(doc.components?.schemas).toHaveProperty('ErrorResponse')
    expect(JSON.stringify(doc.paths?.['/ping']?.get?.responses?.['404'])).toContain(
      '#/components/schemas/ErrorResponse',
    )
  })

  it('carries each operationId', () => {
    expect(doc.paths?.['/echo']?.post?.operationId).toBe('echo')
  })
})

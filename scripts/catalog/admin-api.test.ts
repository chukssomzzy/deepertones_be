import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { httpRequest, isRecord, readAnswer } from './admin-api'

// The shared pieces of the two catalog commands that are not covered through them: the real request wiring, the answer sorter and the object guard.

describe('isRecord', () => {
  it.each([[{}], [{ a: 1 }]])('accepts the object %j', (value) => {
    expect(isRecord(value)).toBe(true)
  })

  it.each([[[]], [[{}]], [null], [undefined], ['text'], [3]])('refuses %j, so a list is never taken for an object', (value) => {
    expect(isRecord(value)).toBe(false)
  })
})

describe('readAnswer', () => {
  it('reads the success envelope\'s data', () => {
    expect(readAnswer({ status: 200, ok: true, body: { success: true, data: { a: 1 } } })).toEqual({ kind: 'data', data: { a: 1 } })
  })

  it('reads an error envelope\'s code, message and details', () => {
    expect(readAnswer({ status: 409, ok: false, body: { success: false, message: 'stale', error: { code: 'CATALOG_STALE', details: { x: 1 } } } })).toEqual({
      kind: 'refused',
      status: 409,
      code: 'CATALOG_STALE',
      message: 'stale',
      details: { x: 1 },
    })
  })

  it.each([
    ['a success whose data is a list', { status: 200, ok: true, body: { success: true, data: [] } }],
    ['text', { status: 502, ok: false, body: '<html>Bad gateway</html>' }],
    ['a 3xx with no body', { status: 302, ok: false, body: '' }],
  ])('calls %s unexpected, with its status', (_label, res) => {
    expect(readAnswer(res)).toEqual({ kind: 'unexpected', status: res.status })
  })
})

describe('httpRequest', () => {
  let server: Server | undefined
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())))

  const serve = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
    server = createServer(handler)
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it('does not follow a redirect, so the admin token is never sent to wherever it points: the 3xx is the answer', async () => {
    let followed = false
    const base = await serve((req, res) => {
      if (req.url === '/elsewhere') {
        followed = true
        res.end('{}')
        return
      }
      res.writeHead(302, { location: '/elsewhere' }).end()
    })

    const res = await httpRequest(`${base}/start`, { headers: { 'X-Admin-Token': 'tok' }, timeoutMs: 5000 })

    expect(res.status).toBe(302)
    expect(res.ok).toBe(false)
    expect(followed).toBe(false)
  })
})

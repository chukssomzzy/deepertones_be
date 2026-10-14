import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { CACHE_CONTROL, MANIFEST_KEY } from './plan'
import { syncAssets, type R2Client } from './sync'

const BUCKET = 'deepertones-assets'
const DOMAIN = 'assets.deepertones.com'
const ZONE = 'deepertones.com'
const ZONE_ID = 'zone-123'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
// Known-good literals (FIPS 180 test vectors).
const SHA_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

const logo = () => ({ key: 'email/logo.png', bytes: enc('hello') })
const note = () => ({ key: 'notes.txt', bytes: enc('abc') })

interface Put { key: string; body: Uint8Array; contentType: string; cacheControl: string }

function fakeR2(opts: { putFails?: string } = {}) {
  const objects = new Map<string, Uint8Array>()
  const state = { bucket: false, domains: [] as string[] }
  const calls = { create: 0, attach: 0, zone: 0, puts: [] as Put[], reads: [] as string[] }
  const order: string[] = []
  const client: R2Client = {
    async bucketExists() { calls.reads.push('bucketExists'); return state.bucket },
    async createBucket() { calls.create++; state.bucket = true },
    async customDomains() { calls.reads.push('customDomains'); return state.domains },
    async zoneId(name) { calls.zone++; expect(name).toBe(ZONE); return ZONE_ID },
    async attachDomain(bucket, domain, zoneId) {
      expect([bucket, domain, zoneId]).toEqual([BUCKET, DOMAIN, ZONE_ID])
      calls.attach++; state.domains.push(domain)
    },
    async getObject(_b, key) { calls.reads.push(`get:${key}`); return objects.get(key) ?? null },
    async putObject(_b, key, body, headers) {
      if (key === opts.putFails) throw new Error(`boom ${key}`)
      calls.puts.push({ key, body, ...headers }); order.push(key); objects.set(key, body)
    },
  }
  return { client, objects, state, calls, order }
}

const run = (r: ReturnType<typeof fakeR2>, files: { key: string; bytes: Uint8Array }[], extra = {}) =>
  syncAssets({ client: r.client, files, bucket: BUCKET, domain: DOMAIN, zone: ZONE, log: () => {}, ...extra })

const manifestOf = (r: ReturnType<typeof fakeR2>) => JSON.parse(dec(r.objects.get(MANIFEST_KEY)!))

describe('syncAssets', () => {
  let r: ReturnType<typeof fakeR2>
  beforeEach(() => { r = fakeR2() })

  it('bootstraps an empty account: bucket, domain, every file, then the manifest last', async () => {
    const result = await run(r, [logo(), note()])

    expect(result).toEqual({
      createdBucket: true, attachedDomain: true,
      uploaded: ['email/logo.png', 'notes.txt'], unchanged: [], orphaned: [],
    })
    expect(r.calls.create).toBe(1)
    expect(r.calls.attach).toBe(1)
    const byKey = Object.fromEntries(r.calls.puts.map((p) => [p.key, p]))
    expect(byKey['email/logo.png']).toMatchObject({ contentType: 'image/png', cacheControl: CACHE_CONTROL })
    expect(byKey['notes.txt']).toMatchObject({ contentType: 'text/plain; charset=utf-8', cacheControl: CACHE_CONTROL })
    expect(byKey[MANIFEST_KEY]!.contentType).toBe('application/json')
    expect(r.order.at(-1)).toBe(MANIFEST_KEY)
    expect(manifestOf(r)).toEqual({ version: 1, files: { 'email/logo.png': SHA_HELLO, 'notes.txt': SHA_ABC } })
  })

  it('writes nothing on a second run with unchanged files', async () => {
    await run(r, [logo(), note()])
    const before = r.calls.puts.length
    const result = await run(r, [logo(), note()])

    expect(r.calls.puts.length).toBe(before)
    expect(r.calls.create).toBe(1)
    expect(r.calls.attach).toBe(1)
    expect(result).toEqual({
      createdBucket: false, attachedDomain: false,
      uploaded: [], unchanged: ['email/logo.png', 'notes.txt'], orphaned: [],
    })
  })

  it('uploads only the changed file, then rewrites the manifest', async () => {
    await run(r, [logo(), note()])
    r.calls.puts.length = 0; r.order.length = 0

    const result = await run(r, [logo(), { key: 'notes.txt', bytes: enc('changed') }])

    expect(result.uploaded).toEqual(['notes.txt'])
    expect(result.unchanged).toEqual(['email/logo.png'])
    expect(r.order).toEqual(['notes.txt', MANIFEST_KEY])
    expect(manifestOf(r).files['notes.txt']).toBe(createHash('sha256').update('changed').digest('hex'))
  })

  it('never deletes a removed file, reports it orphaned, and keeps it in the manifest', async () => {
    await run(r, [logo(), note()])
    r.calls.puts.length = 0

    const second = await run(r, [logo()])
    expect(second.orphaned).toEqual(['notes.txt'])
    expect(second.uploaded).toEqual([])
    expect(r.objects.has('notes.txt')).toBe(true)
    expect(manifestOf(r).files).toEqual({ 'email/logo.png': SHA_HELLO, 'notes.txt': SHA_ABC })

    const third = await run(r, [logo()])
    expect(third.orphaned).toEqual(['notes.txt'])
  })

  it('skips create and attach when the bucket and domain already exist', async () => {
    r.state.bucket = true
    r.state.domains.push(DOMAIN)
    const result = await run(r, [logo()])

    expect(r.calls.create).toBe(0)
    expect(r.calls.attach).toBe(0)
    expect(result.createdBucket).toBe(false)
    expect(result.attachedDomain).toBe(false)
    expect(result.uploaded).toEqual(['email/logo.png'])
  })

  it('dry run only reads, yet reports what it would upload', async () => {
    const result = await run(r, [logo(), note()], { dryRun: true })

    expect(r.calls.create).toBe(0)
    expect(r.calls.attach).toBe(0)
    expect(r.calls.puts).toEqual([])
    expect(result.uploaded).toEqual(['email/logo.png', 'notes.txt'])
  })

  it('dry run does not write even after a real sync, and reports only the delta', async () => {
    await run(r, [logo(), note()])
    r.calls.puts.length = 0
    const result = await run(r, [logo(), { key: 'notes.txt', bytes: enc('changed') }], { dryRun: true })

    expect(r.calls.puts).toEqual([])
    expect(result.uploaded).toEqual(['notes.txt'])
    expect(result.unchanged).toEqual(['email/logo.png'])
  })

  it('force uploads every file even when unchanged', async () => {
    await run(r, [logo(), note()])
    r.calls.puts.length = 0
    const result = await run(r, [logo(), note()], { force: true })

    expect(result.uploaded).toEqual(['email/logo.png', 'notes.txt'])
    expect(r.calls.puts.map((p) => p.key)).toContain('email/logo.png')
  })

  it('rejects and leaves the manifest unwritten when an upload fails, so the next run retries', async () => {
    const failing = fakeR2({ putFails: 'notes.txt' })
    await expect(run(failing, [logo(), note()])).rejects.toThrow(/notes\.txt/)
    expect(failing.objects.has(MANIFEST_KEY)).toBe(false)
  })

  it.each([
    ['not JSON', 'this is {not json'],
    ['wrong version', JSON.stringify({ version: 2, files: { 'email/logo.png': SHA_HELLO } })],
  ])('treats a manifest that is %s as absent and uploads everything', async (_name, body) => {
    r.state.bucket = true
    r.state.domains.push(DOMAIN)
    r.objects.set(MANIFEST_KEY, enc(body))

    const result = await run(r, [logo()])

    expect(result.uploaded).toEqual(['email/logo.png'])
    expect(manifestOf(r)).toEqual({ version: 1, files: { 'email/logo.png': SHA_HELLO } })
  })

  it.each([[false], [true]])('rejects a bad key up front, before any write (dryRun=%s)', async (dryRun) => {
    await expect(run(r, [{ key: 'a.png', bytes: enc('x') }, { key: 'b.svg', bytes: enc('y') }], { dryRun })).rejects.toThrow(/b\.svg/)
    expect(r.calls.create).toBe(0)
    expect(r.calls.attach).toBe(0)
    expect(r.calls.puts).toEqual([])
  })
})

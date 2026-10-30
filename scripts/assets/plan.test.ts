import { describe, expect, it } from 'vitest'
import { CACHE_CONTROL, MANIFEST_KEY, contentTypeFor, planAssetSync } from './plan'

const manifest = (files: Record<string, string>) => ({ version: 1 as const, files })

describe('planAssetSync', () => {
  it('uploads every file when there is no manifest', () => {
    const plan = planAssetSync([{ key: 'b.png', sha256: 'bb' }, { key: 'a.png', sha256: 'aa' }], null)
    expect(plan).toEqual({ upload: ['a.png', 'b.png'], unchanged: [], orphaned: [] })
  })

  it('splits new, changed and unchanged files against the manifest', () => {
    const plan = planAssetSync(
      [
        { key: 'same.png', sha256: '1' },
        { key: 'changed.png', sha256: '2new' },
        { key: 'new.png', sha256: '3' },
      ],
      manifest({ 'same.png': '1', 'changed.png': '2old' }),
    )
    expect(plan).toEqual({ upload: ['changed.png', 'new.png'], unchanged: ['same.png'], orphaned: [] })
  })

  it('reports manifest keys missing locally as orphaned, never as upload', () => {
    const plan = planAssetSync([{ key: 'a.png', sha256: '1' }], manifest({ 'a.png': '1', 'z.png': '9', 'gone.png': '8' }))
    expect(plan.orphaned).toEqual(['gone.png', 'z.png'])
    expect(plan.upload).toEqual([])
  })

  it('uploads everything when forced, even unchanged files', () => {
    const plan = planAssetSync([{ key: 'a.png', sha256: '1' }], manifest({ 'a.png': '1' }), { force: true })
    expect(plan.upload).toEqual(['a.png'])
    expect(plan.unchanged).toEqual([])
  })

  it('rejects a local file that collides with the manifest key', () => {
    expect(() => planAssetSync([{ key: MANIFEST_KEY, sha256: '1' }], null)).toThrow()
  })

  it('rejects a local file under the catalog/ prefix, which the Worker owns', () => {
    expect(() => planAssetSync([{ key: 'email/logo.png', sha256: '1' }, { key: 'catalog/staging/products/x.jpg', sha256: '2' }], null)).toThrow(
      /catalog\/staging\/products\/x\.jpg.*reserved.*Worker/,
    )
  })

  it('only reserves the catalog/ prefix, not a name that merely starts with it', () => {
    expect(planAssetSync([{ key: 'catalogue/a.png', sha256: '1' }], null).upload).toEqual(['catalogue/a.png'])
  })
})

describe('contentTypeFor', () => {
  it.each([
    ['email/logo.png', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.gif', 'image/gif'],
    ['a.webp', 'image/webp'],
    ['favicon.ico', 'image/x-icon'],
    ['data.json', 'application/json'],
    ['notes.txt', 'text/plain; charset=utf-8'],
    ['site.css', 'text/css; charset=utf-8'],
    ['share-card/label.ttf', 'font/ttf'],
  ])('maps %s to %s', (key, type) => {
    expect(contentTypeFor(key)).toBe(type)
  })

  it('is case-insensitive on the extension', () => {
    expect(contentTypeFor('Logo.PNG')).toBe('image/png')
  })

  it('rejects svg, naming the key', () => {
    expect(() => contentTypeFor('email/mark.svg')).toThrow(/email\/mark\.svg/)
  })

  it('rejects unknown extensions, naming the key', () => {
    expect(() => contentTypeFor('docs/file.xyz')).toThrow(/docs\/file\.xyz/)
  })
})

describe('constants', () => {
  it('pins the cache policy and manifest key', () => {
    expect(CACHE_CONTROL).toBe('public, max-age=86400')
    expect(MANIFEST_KEY).toBe('_sync-manifest.json')
  })
})

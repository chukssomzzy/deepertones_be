import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BRAND } from '../../src/emails/brand'
import { ASSET_DOMAIN } from './config'

describe('BRAND.logoUrl', () => {
  it('points at the asset domain', () => {
    expect(BRAND.logoUrl.startsWith(`https://${ASSET_DOMAIN}/`)).toBe(true)
    expect(BRAND.logoUrl.startsWith('https://assets.deepertones.com/')).toBe(true)
  })

  it('names a file that exists under assets/', () => {
    const key = new URL(BRAND.logoUrl).pathname.slice(1)
    expect(existsSync(path.resolve(import.meta.dirname, '../../assets', key))).toBe(true)
  })
})

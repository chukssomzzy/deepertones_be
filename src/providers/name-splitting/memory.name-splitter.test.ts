import { describe, expect, it } from 'vitest'
import { MemoryNameSplitter } from './memory.name-splitter'
import type { NameSplit } from './name-splitter.provider'

const SPLIT: NameSplit = { kind: 'product', brand: 'CeraVe', name: 'Hydrating Facial Cleanser', category: 'skin' }

describe('MemoryNameSplitter', () => {
  it('says not-a-product until told otherwise, then answers with what its function computes from the text', async () => {
    const splitter = new MemoryNameSplitter()
    await expect(splitter.split('cerave cleanser')).resolves.toEqual({ kind: 'not-a-product' })

    splitter.respondWith((text) => (text.includes('cerave') ? SPLIT : { kind: 'not-a-product' }))

    await expect(splitter.split('cerave cleanser')).resolves.toEqual(SPLIT)
    await expect(splitter.split('hello there')).resolves.toEqual({ kind: 'not-a-product' })
  })

  it('records every text it was given, in order', async () => {
    const splitter = new MemoryNameSplitter()

    await splitter.split('first')
    await splitter.split('second')

    expect(splitter.calls).toEqual(['first', 'second'])
  })

  it('failNextWith rejects the next call only, records nothing for it, then recovers', async () => {
    const splitter = new MemoryNameSplitter()
    splitter.respondWith(() => SPLIT)
    const failure = new Error('boom')
    splitter.failNextWith(failure)

    await expect(splitter.split('x')).rejects.toBe(failure)
    expect(splitter.calls).toEqual([])

    await expect(splitter.split('x')).resolves.toEqual(SPLIT)
    expect(splitter.calls).toEqual(['x'])
  })
})

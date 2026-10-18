import { describe, expect, it } from 'vitest'
import type { Mention } from './mention-reader.provider'
import { MemoryMentionReader } from './memory.mention-reader'

const CARO_WHITE: Mention = { kind: 'product', brand: 'Caro White', name: 'Caro White', category: 'skin' }
const FRAGRANCE: Mention = { kind: 'ingredient', name: 'fragrance' }

describe('MemoryMentionReader', () => {
  it('reads no mentions until told otherwise, then answers with what its function computes from the text', async () => {
    const reader = new MemoryMentionReader()
    await expect(reader.read('Caro White and fragrance')).resolves.toEqual([])

    reader.respondWith((text) => (text.includes('Caro') ? [CARO_WHITE, FRAGRANCE] : []))

    await expect(reader.read('Caro White and fragrance')).resolves.toEqual([CARO_WHITE, FRAGRANCE])
    await expect(reader.read('the white tub from the market')).resolves.toEqual([])
  })

  it('records every text it was given, in order', async () => {
    const reader = new MemoryMentionReader()

    await reader.read('first')
    await reader.read('second')

    expect(reader.calls).toEqual(['first', 'second'])
  })

  it('failNextWith rejects the next call only, records nothing for it, then recovers', async () => {
    const reader = new MemoryMentionReader()
    reader.respondWith(() => [FRAGRANCE])
    const failure = new Error('boom')
    reader.failNextWith(failure)

    await expect(reader.read('x')).rejects.toBe(failure)
    expect(reader.calls).toEqual([])

    await expect(reader.read('x')).resolves.toEqual([FRAGRANCE])
    expect(reader.calls).toEqual(['x'])
  })
})

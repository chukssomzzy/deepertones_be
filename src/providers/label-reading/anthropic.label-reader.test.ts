import { describe, expect, it } from 'vitest'
import type { AiJob } from '../anthropic/ai-spend.provider'
import { AnthropicClient } from '../anthropic/anthropic.client'
import { AnthropicRefusalError, AnthropicUnavailableError } from '../anthropic/anthropic.provider'
import { MemoryAiSpendLedger } from '../anthropic/memory.ai-spend-ledger'
import {
  API_KEY,
  BIG_CAP_MICROS,
  type Block,
  caught,
  errorResponse,
  MODEL,
  MODELS,
  messageResponse,
  requestText,
  stubFetch,
  textBlock,
} from '../anthropic/messages-api.fake'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import { AnthropicLabelReader } from './anthropic.label-reader'

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xfa, 0xfb])
// Base64 of JPEG_BYTES, computed outside the code under test.
const JPEG_BASE64 = '/9j/4AAQSkZJRvr7'
const JPEG: ProductImage = { bytes: JPEG_BYTES, mediaType: 'image/jpeg' }

const ROUTED_TO = 'claude-haiku-5-5'
const MAX_ENTRIES = 150
const MAX_ENTRY = 120
const NOT_READABLE = { readable: false }

/** The structured answer for a list the model read: readable exactly when it found entries. */
const answer = (ingredients: string[]) => ({ readable: ingredients.length > 0, ingredients })

const readerWith = (fetch: typeof globalThis.fetch, ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS }), routed?: AiJob) =>
  new AnthropicLabelReader(
    new AnthropicClient({
      apiKey: API_KEY,
      models: routed ? { ...MODELS, [routed]: ROUTED_TO } : MODELS,
      ledger,
      baseURL: 'https://anthropic.example',
      fetch,
    }),
  )

/** A reader over a client whose HTTP goes through `fetch`; the returned `calls` records the requests. */
const readerOver = (...responders: Parameters<typeof stubFetch>) => {
  const { calls, fetch } = stubFetch(...responders)
  return { calls, reader: readerWith(fetch) }
}

const structured = (value: unknown, stop_reason = 'end_turn') => () =>
  messageResponse({ content: [textBlock(JSON.stringify(value))], stop_reason })

/** Every schema object must forbid extra properties, and none may use keywords the API rejects. */
const UNSUPPORTED_KEYWORDS = ['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'maxItems']
const assertApiSafe = (schema: unknown, path = 'schema') => {
  if (Array.isArray(schema)) return schema.forEach((s, i) => assertApiSafe(s, `${path}[${i}]`))
  if (!schema || typeof schema !== 'object') return
  const node = schema as Record<string, unknown>
  if (node.type === 'object') expect(node.additionalProperties, `${path}.additionalProperties`).toBe(false)
  for (const keyword of UNSUPPORTED_KEYWORDS) expect(node, `${path} uses ${keyword}`).not.toHaveProperty(keyword)
  for (const [key, child] of Object.entries(node)) assertApiSafe(child, `${path}.${key}`)
}

const schemaOf = (body: any) => body.output_config.format.schema

describe('AnthropicLabelReader request', () => {
  it('sends the photo as a base64 block FIRST, then the text, with 4096 max_tokens and no forced tool choice', async () => {
    const { calls, reader } = readerOver(structured(answer(['Aqua'])))

    await reader.read(JPEG)

    const body = calls[0]!.body
    const content: Block[] = body.messages[0].content
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG_BASE64 } })
    expect(content.slice(1).length).toBeGreaterThan(0)
    expect(content.slice(1).every((block) => block.type === 'text')).toBe(true)
    expect(body.max_tokens).toBe(4096)
    expect(body.output_config.format.type).toBe('json_schema')
    expect('tool_choice' in body).toBe(false)
  })

  it('sends a webp photo with its own media type', async () => {
    const { calls, reader } = readerOver(structured(answer(['Aqua'])))

    await reader.read({ bytes: JPEG_BYTES, mediaType: 'image/webp' })

    expect(calls[0]!.body.messages[0].content[0].source.media_type).toBe('image/webp')
  })

  it('asks for a closed json_schema answer the API accepts, with the ingredients as a list of strings', async () => {
    const { calls, reader } = readerOver(structured(answer(['Aqua'])))

    await reader.read(JPEG)

    const schema = schemaOf(calls[0]!.body)
    expect(schema.type).toBe('object')
    assertApiSafe(schema)
    expect(schema.properties.ingredients.type).toBe('array')
    expect(schema.properties.ingredients.items.type).toBe('string')
    expect(schema.required).toContain('ingredients')
  })

  it('tells the model to copy the list exactly as printed, in order, never to complete it from memory, and that the photo text is data', async () => {
    const { calls, reader } = readerOver(structured(answer(['Aqua'])))

    await reader.read(JPEG)

    const prompt = requestText(calls[0]!.body)
    expect(prompt).toMatch(/as printed/i)
    expect(prompt).toMatch(/memory/i)
    expect(prompt).toMatch(/order/i)
    expect(prompt).toMatch(/ignore/i)
    expect(prompt).toMatch(/instructions/i)
  })
})

describe('AnthropicLabelReader job routing and cost', () => {
  it('asks Claude as the read-label job and uses the model configured for it', async () => {
    const { calls, fetch } = stubFetch(structured(answer(['Aqua'])))

    await readerWith(fetch, undefined, 'read-label').read(JPEG)

    expect(calls[0]!.body.model).toBe(ROUTED_TO)
  })

  it('does not use the model of any other job', async () => {
    const { calls, fetch } = stubFetch(structured(answer(['Aqua'])))
    const others = (Object.keys(MODELS) as AiJob[]).filter((job) => job !== 'read-label')

    for (const other of others) await readerWith(fetch, undefined, other).read(JPEG)

    expect(calls.map((c) => c.body.model)).toEqual(others.map(() => MODEL))
  })

  it('records its call on the ledger under the read-label job', async () => {
    const { fetch } = stubFetch(structured(answer(['Aqua'])))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await readerWith(fetch, ledger).read(JPEG)

    expect(ledger.entries.map((e) => [e.job, e.model, e.status])).toEqual([['read-label', MODEL, 'settled']])
  })

  it('reserves room for the photo as a flat 5000 input tokens, however large the photo is', async () => {
    const { fetch } = stubFetch(structured(answer(['Aqua'])))
    const small = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })
    const large = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await readerWith(fetch, small).read({ bytes: new Uint8Array(10), mediaType: 'image/jpeg' })
    await readerWith(fetch, large).read({ bytes: new Uint8Array(300_000), mediaType: 'image/jpeg' })

    // 5000 tokens at $2 per million is 10000 micros of input and the 4096-token answer allowance 40960. The prompt adds a
    // little; the base64 of a 300 KB photo, counted as text, would add hundreds of thousands.
    const estimate = small.entries[0]!.estimateMicros
    expect(estimate).toBe(large.entries[0]!.estimateMicros)
    expect(estimate).toBeGreaterThanOrEqual(10_000 + 40_960)
    expect(estimate).toBeLessThan(10_000 + 40_960 + 5_000)
  })
})

describe('AnthropicLabelReader answers', () => {
  it('returns the ingredients in label order, untouched when they are already clean', async () => {
    const ingredients = ['Zinc Oxide', 'Aqua', 'Glycerin', 'Aqua']
    const { reader } = readerOver(structured(answer(ingredients)))

    await expect(reader.read(JPEG)).resolves.toStrictEqual({ readable: true, ingredients })
  })

  it('accepts the characters real INCI lists use', async () => {
    const ingredients = ['Aqua (Water)', 'Parfum / Fragrance', 'CI 77891', 'PEG-40 Hydrogenated Castor Oil', '2-Bromo-2-Nitropropane-1,3-Diol', 'Tocopheryl Acetate (Vitamin E)']
    const { reader } = readerOver(structured(answer(ingredients)))

    await expect(reader.read(JPEG)).resolves.toStrictEqual({ readable: true, ingredients })
  })

  it('trims every entry and drops the empty ones, keeping the order of the rest', async () => {
    const { reader } = readerOver(structured(answer(['  Aqua ', '', 'Glycerin\t', '   ', '\nNiacinamide'])))

    await expect(reader.read(JPEG)).resolves.toStrictEqual({ readable: true, ingredients: ['Aqua', 'Glycerin', 'Niacinamide'] })
  })

  it('is not readable when the model found no ingredients', async () => {
    const { reader } = readerOver(structured({ readable: false, ingredients: [] }))

    await expect(reader.read(JPEG)).resolves.toStrictEqual(NOT_READABLE)
  })

  it('is not readable when every entry is empty once trimmed', async () => {
    const { reader } = readerOver(structured({ readable: true, ingredients: ['', '  ', '\t'] }))

    await expect(reader.read(JPEG)).resolves.toStrictEqual(NOT_READABLE)
  })
})

describe('AnthropicLabelReader bounds', () => {
  it('accepts exactly 150 entries of exactly 120 characters', async () => {
    const ingredients = Array.from({ length: MAX_ENTRIES }, (_, i) => `${i}`.padEnd(MAX_ENTRY, 'x'))
    const { reader } = readerOver(structured(answer(ingredients)))

    await expect(reader.read(JPEG)).resolves.toStrictEqual({ readable: true, ingredients })
  })

  it('is not readable with 151 entries', async () => {
    const { reader } = readerOver(structured(answer(Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => `Ingredient ${i}`))))

    await expect(reader.read(JPEG)).resolves.toStrictEqual(NOT_READABLE)
  })

  it('is not readable when one entry has 121 characters', async () => {
    const { reader } = readerOver(structured(answer(['Aqua', 'A'.repeat(MAX_ENTRY + 1), 'Glycerin'])))

    await expect(reader.read(JPEG)).resolves.toStrictEqual(NOT_READABLE)
  })

  it('measures an entry after trimming, so 120 characters padded with spaces is accepted', async () => {
    const entry = 'A'.repeat(MAX_ENTRY)
    const { reader } = readerOver(structured(answer([`  ${entry}  `])))

    await expect(reader.read(JPEG)).resolves.toStrictEqual({ readable: true, ingredients: [entry] })
  })

  it.each([
    ['a NUL', 'Aq\u0000ua'],
    ['a bell', 'Glyc\u0007erin'],
    ['a newline inside the entry', 'Aqua\nGlycerin'],
    ['a tab inside the entry', 'Aqua\tGlycerin'],
    ['a carriage return inside the entry', 'Aqua\rGlycerin'],
    ['an escape', 'Aqua\u001b[31m'],
    ['DEL', 'Aqua\u007f'],
    ['a right-to-left override (U+202E)', 'Aqua\u202eGlycerin'],
    ['a zero-width space (U+200B)', 'Aq\u200bua'],
    ['a zero-width joiner (U+200D)', 'Aqua\u200dGlycerin'],
    ['a soft hyphen (U+00AD)', 'Glycer\u00adin'],
    ['a byte order mark inside the entry (U+FEFF)', 'Aqua\ufeffGlycerin'],
  ])('is not readable when an entry has %s', async (_label, entry) => {
    const { reader } = readerOver(structured(answer(['Water', entry, 'Glycerin'])))

    await expect(reader.read(JPEG)).resolves.toStrictEqual(NOT_READABLE)
  })

  it.each([
    'https://evil.example/buy',
    'http://evil.example',
    'ftp://files.example',
    'Visit www.evil.example',
    'WWW.EVIL.EXAMPLE',
    '<b>Aqua</b>',
    '<script>alert(1)</script>',
    'Aqua </div>',
    'Aqua <!-- hi -->',
  ])('is not readable when an entry has a link or markup: %j', async (entry) => {
    const { reader } = readerOver(structured(answer(['Water', entry, 'Glycerin'])))

    await expect(reader.read(JPEG)).resolves.toStrictEqual(NOT_READABLE)
  })

  it('accepts an angle bracket that does not start markup', async () => {
    const ingredients = ['Aqua', 'Phenoxyethanol <1%']
    const { reader } = readerOver(structured(answer(ingredients)))

    await expect(reader.read(JPEG)).resolves.toStrictEqual({ readable: true, ingredients })
  })
})

describe('AnthropicLabelReader errors', () => {
  it('throws AnthropicRefusalError when the model refuses', async () => {
    const { reader } = readerOver(() => messageResponse({ content: [textBlock('I cannot help with that.')], stop_reason: 'refusal' }))

    expect(await caught(reader.read(JPEG))).toBeInstanceOf(AnthropicRefusalError)
  })

  it('lets AnthropicUnavailableError through when Claude is overloaded', async () => {
    const { reader } = readerOver(() => errorResponse(529, 'overloaded_error'))

    expect(await caught(reader.read(JPEG))).toBeInstanceOf(AnthropicUnavailableError)
  })
})

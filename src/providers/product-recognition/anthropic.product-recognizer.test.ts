import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { AnthropicProductRecognizer } from './anthropic.product-recognizer'

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xfa, 0xfb])
// Base64 of JPEG_BYTES, computed outside the code under test.
const JPEG_BASE64 = '/9j/4AAQSkZJRvr7'
const JPEG: ProductImage = { bytes: JPEG_BYTES, mediaType: 'image/jpeg' }

const ROUTED_TO = 'claude-haiku-5-5'
const MAX_FIELD = 120

/** The structured answer for a clearly read product; a test overrides only what it is about. */
const product = (overrides: Record<string, unknown> = {}) => ({
  classification: 'beauty-product',
  brand: 'Glow Co',
  name: 'Bright Tone Serum',
  variant: 'Extra Strength',
  category: 'skin',
  confidence: 0.87,
  ...overrides,
})

/** Every job on MODEL, except `routed`, which goes to ROUTED_TO: whichever job the adapter uses shows in the model it sends. */
const make = (ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS }), routed?: AiJob) =>
  new AnthropicProductRecognizer(
    new AnthropicClient({
      apiKey: API_KEY,
      models: routed ? { ...MODELS, [routed]: ROUTED_TO } : MODELS,
      ledger,
      apiUrl: 'https://anthropic.example/v1/messages',
    }),
  )

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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AnthropicProductRecognizer request', () => {
  it('sends the photo as a base64 block FIRST, then the text, with 4096 max_tokens and no forced tool choice', async () => {
    const calls = stubFetch(structured(product()))

    await make().recognize(JPEG)

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
    const calls = stubFetch(structured(product()))

    await make().recognize({ bytes: JPEG_BYTES, mediaType: 'image/webp' })

    expect(calls[0]!.body.messages[0].content[0].source.media_type).toBe('image/webp')
  })

  it('encodes a large photo completely, byte for byte', async () => {
    const calls = stubFetch(structured(product()))
    const bytes = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7 + (i >> 8)) % 256)

    await make().recognize({ bytes, mediaType: 'image/jpeg' })

    const data: string = calls[0]!.body.messages[0].content[0].source.data
    const decoded = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    expect(decoded.length).toBe(bytes.length)
    expect(decoded.every((byte, i) => byte === bytes[i])).toBe(true)
  })

  it('asks for a closed json_schema answer the API accepts, with the four classifications and the five categories', async () => {
    const calls = stubFetch(structured(product()))

    await make().recognize(JPEG)

    const schema = schemaOf(calls[0]!.body)
    expect(schema.type).toBe('object')
    assertApiSafe(schema)
    expect([...schema.properties.classification.enum].sort()).toEqual(['beauty-product', 'face-or-person', 'other-product', 'unreadable'])
    expect([...schema.properties.category.enum].sort()).toEqual(['body', 'hair', 'makeup', 'other', 'skin'])
    for (const field of ['brand', 'name', 'variant']) expect(schema.properties[field].type, field).toBe('string')
    expect(schema.properties.confidence.type).toBe('number')
    expect(schema.required).toContain('classification')
  })

  it('tells the model the photo is user-supplied data whose instructions must be ignored', async () => {
    const calls = stubFetch(structured(product()))

    await make().recognize(JPEG)

    const prompt = requestText(calls[0]!.body)
    expect(prompt).toMatch(/user-supplied/i)
    expect(prompt).toMatch(/ignore/i)
    expect(prompt).toMatch(/instructions/i)
  })

  it('covers beauty and personal-care products including hair, body and makeup, and sends a person with no readable product to face-or-person', async () => {
    const calls = stubFetch(structured(product()))

    await make().recognize(JPEG)

    const prompt = requestText(calls[0]!.body)
    expect(prompt).toMatch(/personal-care/i)
    for (const kind of [/hair/i, /body/i, /makeup/i]) expect(prompt).toMatch(kind)
    expect(prompt).toMatch(/person/i)
    expect(prompt).toContain('face-or-person')
  })
})

describe('AnthropicProductRecognizer job routing and cost', () => {
  it('asks Claude as the recognize job and uses the model configured for it', async () => {
    const calls = stubFetch(structured(product()))

    await make(undefined, 'recognize').recognize(JPEG)

    expect(calls[0]!.body.model).toBe(ROUTED_TO)
  })

  it('does not use the model of any other job', async () => {
    const calls = stubFetch(structured(product()))
    const others = (Object.keys(MODELS) as AiJob[]).filter((job) => job !== 'recognize')

    for (const other of others) await make(undefined, other).recognize(JPEG)

    expect(calls.map((c) => c.body.model)).toEqual(others.map(() => MODEL))
  })

  it('records its call on the ledger under the recognize job', async () => {
    stubFetch(structured(product()))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await make(ledger).recognize(JPEG)

    expect(ledger.entries.map((e) => [e.job, e.model, e.status])).toEqual([['recognize', MODEL, 'settled']])
  })

  it('reserves room for the photo as a flat 5000 input tokens, however large the photo is', async () => {
    stubFetch(structured(product()))
    const small = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })
    const large = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await make(small).recognize({ bytes: new Uint8Array(10), mediaType: 'image/jpeg' })
    await make(large).recognize({ bytes: new Uint8Array(300_000), mediaType: 'image/jpeg' })

    // 5000 tokens at $2 per million is 10000 micros of input and the 4096-token answer allowance 40960. The prompt adds a
    // little; the base64 of a 300 KB photo, counted as text, would add hundreds of thousands.
    const estimate = small.entries[0]!.estimateMicros
    expect(estimate).toBe(large.entries[0]!.estimateMicros)
    expect(estimate).toBeGreaterThanOrEqual(10_000 + 40_960)
    expect(estimate).toBeLessThan(10_000 + 40_960 + 5_000)
  })
})

describe('AnthropicProductRecognizer answers', () => {
  it('returns a read product with its brand, name, variant, category and confidence', async () => {
    stubFetch(structured(product()))

    await expect(make().recognize(JPEG)).resolves.toStrictEqual({
      classification: 'beauty-product',
      brand: 'Glow Co',
      name: 'Bright Tone Serum',
      variant: 'Extra Strength',
      category: 'skin',
      confidence: 0.87,
    })
  })

  it.each(['skin', 'hair', 'body', 'makeup', 'other'])('keeps the category %s', async (category) => {
    stubFetch(structured(product({ category })))

    await expect(make().recognize(JPEG)).resolves.toMatchObject({ classification: 'beauty-product', category })
  })

  it('trims brand, name and variant', async () => {
    stubFetch(structured(product({ brand: '  Glow Co ', name: '\tBright Tone Serum\n', variant: ' Extra Strength  ' })))

    await expect(make().recognize(JPEG)).resolves.toMatchObject({ brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Extra Strength' })
  })

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['missing', undefined],
  ])('leaves the variant out when it is %s', async (_label, variant) => {
    stubFetch(structured(product({ variant })))

    const result = await make().recognize(JPEG)

    expect(result).toMatchObject({ classification: 'beauty-product', brand: 'Glow Co', name: 'Bright Tone Serum' })
    expect(result).not.toHaveProperty('variant')
  })

  it.each(['other-product', 'face-or-person', 'unreadable'])('returns only the classification for %s, even if the model also wrote product fields', async (classification) => {
    stubFetch(structured(product({ classification })))

    await expect(make().recognize(JPEG)).resolves.toStrictEqual({ classification })
  })

  it.each([
    ['an empty brand', { brand: '' }],
    ['a brand of only spaces', { brand: '  \t ' }],
    ['no brand', { brand: undefined }],
    ['an empty name', { name: '' }],
    ['a name of only spaces', { name: '   ' }],
    ['no name', { name: undefined }],
  ])('treats a beauty product with %s as unreadable', async (_label, overrides) => {
    stubFetch(structured(product(overrides)))

    await expect(make().recognize(JPEG)).resolves.toStrictEqual({ classification: 'unreadable' })
  })
})

describe('AnthropicProductRecognizer confidence', () => {
  it.each([
    [0.42, 0.42],
    [0, 0],
    [1, 1],
    [1.7, 1],
    [1.0000001, 1],
    [-0.2, 0],
    [-1000, 0],
  ])('returns confidence %s as %s', async (confidence, expected) => {
    stubFetch(structured(product({ confidence })))

    await expect(make().recognize(JPEG)).resolves.toMatchObject({ confidence: expected })
  })
})

describe('AnthropicProductRecognizer length bounds', () => {
  const fields = ['brand', 'name', 'variant'] as const

  it.each(fields)('accepts a %s of exactly 120 characters', async (field) => {
    const value = 'x'.repeat(MAX_FIELD)
    stubFetch(structured(product({ [field]: value })))

    await expect(make().recognize(JPEG)).resolves.toMatchObject({ classification: 'beauty-product', [field]: value })
  })

  it.each(fields)('treats a %s of 121 characters as unreadable', async (field) => {
    stubFetch(structured(product({ [field]: 'x'.repeat(MAX_FIELD + 1) })))

    await expect(make().recognize(JPEG)).resolves.toStrictEqual({ classification: 'unreadable' })
  })

  it.each(fields)('measures a %s after trimming, so 120 characters padded with spaces is accepted', async (field) => {
    const value = 'x'.repeat(MAX_FIELD)
    stubFetch(structured(product({ [field]: `  ${value}  ` })))

    await expect(make().recognize(JPEG)).resolves.toMatchObject({ classification: 'beauty-product', [field]: value })
  })
})

describe('AnthropicProductRecognizer links and markup', () => {
  const fields = ['brand', 'name', 'variant'] as const
  const bad = [
    'https://evil.example/buy',
    'http://evil.example',
    'ftp://files.example',
    'javascript://x',
    'Visit www.evil.example',
    'WWW.EVIL.EXAMPLE',
    'Serum <b>bold</b>',
    '<script>alert(1)</script>',
    'Serum </div>',
    'Serum <!-- hi -->',
  ]
  const cases = fields.flatMap((field) => bad.map((value) => [field, value] as const))

  it.each(cases)('treats a %s of %j as unreadable', async (field, value) => {
    stubFetch(structured(product({ [field]: value })))

    await expect(make().recognize(JPEG)).resolves.toStrictEqual({ classification: 'unreadable' })
  })

  it.each([
    ['SPF < 30 Day Cream'],
    ['Retinol <1% Night Serum'],
    ['pH > 5 Toner'],
    ['Vitamin C + E (10%)'],
    ["L'Oréal Paris"],
  ])('accepts ordinary text such as %j', async (name) => {
    stubFetch(structured(product({ name })))

    await expect(make().recognize(JPEG)).resolves.toMatchObject({ classification: 'beauty-product', name })
  })
})

describe('AnthropicProductRecognizer hidden characters', () => {
  const fields = ['brand', 'name', 'variant'] as const
  const hidden = [
    ['a NUL', 'Glow\u0000 Co'],
    ['a newline', 'Glow\nCo'],
    ['a tab', 'Glow\tCo'],
    ['a right-to-left override (U+202E)', 'Glow\u202eCo'],
    ['a zero-width space (U+200B)', 'Glow\u200b Co'],
    ['a zero-width joiner (U+200D)', 'Glow\u200dCo'],
    ['a soft hyphen (U+00AD)', 'Glow\u00adCo'],
  ] as const
  const cases = fields.flatMap((field) => hidden.map(([label, value]) => [field, label, value] as const))

  it.each(cases)('treats a %s with %s as unreadable', async (field, _label, value) => {
    stubFetch(structured(product({ [field]: value })))

    await expect(make().recognize(JPEG)).resolves.toStrictEqual({ classification: 'unreadable' })
  })

  it.each(fields)('treats a %s that is only a zero-width space as unreadable', async (field) => {
    stubFetch(structured(product({ [field]: '\u200b' })))

    await expect(make().recognize(JPEG)).resolves.toStrictEqual({ classification: 'unreadable' })
  })

  it('accepts accented and non-Latin text, which has no hidden characters', async () => {
    stubFetch(structured(product({ brand: 'Nuxe Crème', name: 'Huile Prodigieuse® 油', variant: 'Néroli' })))

    await expect(make().recognize(JPEG)).resolves.toMatchObject({ brand: 'Nuxe Crème', name: 'Huile Prodigieuse® 油', variant: 'Néroli' })
  })
})

describe('AnthropicProductRecognizer errors', () => {
  it('throws AnthropicRefusalError when the model refuses', async () => {
    stubFetch(() => messageResponse({ content: [textBlock('I cannot help with that.')], stop_reason: 'refusal' }))

    expect(await caught(make().recognize(JPEG))).toBeInstanceOf(AnthropicRefusalError)
  })

  it('lets AnthropicUnavailableError through when Claude is overloaded', async () => {
    stubFetch(() => errorResponse(529, 'overloaded_error'))

    expect(await caught(make().recognize(JPEG))).toBeInstanceOf(AnthropicUnavailableError)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicClient } from '../anthropic/anthropic.client'
import type { AiJob } from '../anthropic/ai-spend.provider'
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
import type { ProductIdentity } from '../product-research/product-researcher.provider'
import { AnthropicProductAnalyst } from './anthropic.product-analyst'
import type { AnalysisInput, DraftConcern, ProductImage } from './product-analyst.provider'

const PRODUCT: ProductIdentity = { brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Extra Strength', category: 'skin' }
const OTHER: ProductIdentity = { brand: 'Glow Company', name: 'Brighttone Serum', category: 'skin' }

const KINDS = ['irritation', 'allergen', 'restricted-or-banned'] as const
const SEVERITIES = ['info', 'caution', 'avoid'] as const
const TRAITS = ['sensitive-skin', 'fitzpatrick-v', 'fade-dark-marks'] as const

const INPUT: AnalysisInput = {
  product: PRODUCT,
  ingredients: ['Aqua', 'Hydroquinone', 'Linalool', 'Glycerin'],
  flaggedFacts: [
    {
      kind: 'restricted-or-banned',
      ingredient: 'Hydroquinone',
      rule: 'Prohibited in cosmetic products (EU Annex II entry 1339)',
      source: 'https://cosing.example/annex-ii',
    },
    {
      kind: 'allergen',
      ingredient: 'Linalool',
      rule: 'Labelled fragrance allergen (EU Annex III entry 84)',
      source: 'https://cosing.example/annex-iii',
    },
  ],
  kinds: KINDS,
  severities: SEVERITIES,
  traits: TRAITS,
}

const CONCERN: DraftConcern = {
  kind: 'restricted-or-banned',
  severity: 'avoid',
  ingredients: ['Hydroquinone'],
  why: 'Hydroquinone is banned in cosmetics and sits second in this formula.',
  whoShouldTakeCare: 'Everyone, especially deeper skin tones prone to ochronosis.',
  traits: ['fitzpatrick-v'],
  sources: ['https://cosing.example/annex-ii'],
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xfa, 0xfb])
// Base64 of JPEG_BYTES, computed outside the code under test.
const JPEG_BASE64 = '/9j/4AAQSkZJRvr7'

const ROUTED_TO = 'claude-haiku-5-5'

/** Every job on MODEL, except `routed`, which goes to ROUTED_TO: whichever job a method uses shows in the model it sends. */
const make = (ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS }), routed?: AiJob) =>
  new AnthropicProductAnalyst(
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

const JOBS = Object.keys(MODELS) as AiJob[]

describe('AnthropicProductAnalyst job routing', () => {
  // Each method is run once with ONLY its own job on ROUTED_TO, and once with every other job on ROUTED_TO:
  // it must send ROUTED_TO in the first case and MODEL in the second, which pins the job it asks as.
  const methods: [string, AiJob, (analyst: AnthropicProductAnalyst) => Promise<unknown>, unknown][] = [
    ['analyse', 'analysis', (a) => a.analyse(INPUT), { concerns: [] }],
    ['sameProduct', 'same-product', (a) => a.sameProduct(PRODUCT, OTHER), { same: true }],
    ['imageShowsProduct', 'image-check', (a) => a.imageShowsProduct({ bytes: JPEG_BYTES, mediaType: 'image/jpeg' }, PRODUCT), { matches: true }],
  ]

  it.each(methods)('%s asks Claude as the %s job and uses the model configured for it', async (_method, job, run, reply) => {
    const calls = stubFetch(structured(reply))

    await run(make(undefined, job))

    expect(calls[0]!.body.model).toBe(ROUTED_TO)
  })

  it.each(methods)('%s does not use the model of any other job', async (_method, job, run, reply) => {
    const calls = stubFetch(structured(reply))
    const others = JOBS.filter((other) => other !== job)

    for (const other of others) await run(make(undefined, other))

    expect(calls.map((c) => c.body.model)).toEqual(others.map(() => MODEL))
  })

  it.each(methods)('%s records its call on the ledger under the %s job', async (_method, job, run, reply) => {
    stubFetch(structured(reply))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await run(make(ledger))

    expect(ledger.entries.map((e) => [e.job, e.model, e.status])).toEqual([[job, MODEL, 'settled']])
  })

  it('reserves room for the image as a flat 5000 input tokens, however large the photo is', async () => {
    stubFetch(structured({ matches: true }))
    const small = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })
    const large = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await make(small).imageShowsProduct({ bytes: new Uint8Array(10), mediaType: 'image/png' }, PRODUCT)
    await make(large).imageShowsProduct({ bytes: new Uint8Array(300_000), mediaType: 'image/png' }, PRODUCT)

    // 5000 tokens at $2 per million is 10000 micros of input, the 4096-token answer allowance 40960; the rest of the body is small.
    expect(small.entries[0]!.estimateMicros).toBe(large.entries[0]!.estimateMicros)
    expect(small.entries[0]!.estimateMicros).toBeGreaterThanOrEqual(10_000 + 40_960)
    expect(small.entries[0]!.estimateMicros).toBeLessThan(10_000 + 40_960 + 1_000)
  })
})

describe('AnthropicProductAnalyst.analyse', () => {
  it('returns the concerns from the structured answer', async () => {
    stubFetch(structured({ concerns: [CONCERN] }))

    await expect(make().analyse(INPUT)).resolves.toEqual([CONCERN])
  })

  it('returns no concerns when the model returns none', async () => {
    stubFetch(structured({ concerns: [] }))

    await expect(make().analyse({ ...INPUT, flaggedFacts: [] })).resolves.toEqual([])
  })

  it('requests a json_schema output with no forced tool choice, using the configured model', async () => {
    const calls = stubFetch(structured({ concerns: [] }))

    await make().analyse(INPUT)

    const body = calls[0]!.body
    expect(body.output_config.format.type).toBe('json_schema')
    expect('tool_choice' in body).toBe(false)
    expect(body.model).toBe(MODEL)
    expect(body.max_tokens).toBeGreaterThan(0)
  })

  it('builds the schema enums from the vocabularies it was given, and nothing else', async () => {
    const calls = stubFetch(structured({ concerns: [] }))
    const input = { ...INPUT, kinds: ['kind-a', 'kind-b'], severities: ['sev-x'], traits: ['trait-1', 'trait-2', 'trait-3'] }

    await make().analyse(input)

    const schema = schemaOf(calls[0]!.body)
    const concern = schema.properties.concerns.items.properties
    expect(concern.kind.enum).toEqual(['kind-a', 'kind-b'])
    expect(concern.severity.enum).toEqual(['sev-x'])
    expect(concern.traits.items.enum).toEqual(['trait-1', 'trait-2', 'trait-3'])
  })

  it('uses a schema the API accepts: every object closed, no unsupported constraints', async () => {
    const calls = stubFetch(structured({ concerns: [] }))

    await make().analyse(INPUT)

    const schema = schemaOf(calls[0]!.body)
    expect(schema.type).toBe('object')
    assertApiSafe(schema)
  })

  it('states the length budget for why and whoShouldTakeCare in the prompt and in the schema descriptions', async () => {
    const calls = stubFetch(structured({ concerns: [] }))

    await make().analyse(INPUT)

    const body = calls[0]!.body
    expect(body.system).toContain('2-3 sentences, at most 450 characters')
    expect(body.system).toContain('one sentence, at most 200 characters')
    const concern = schemaOf(body).properties.concerns.items.properties
    expect(concern.why.description).toContain('450 characters')
    expect(concern.whoShouldTakeCare.description).toContain('200 characters')
  })

  it('puts the product, its ingredients and every flagged fact in the prompt', async () => {
    const calls = stubFetch(structured({ concerns: [] }))

    await make().analyse(INPUT)

    const prompt = requestText(calls[0]!.body)
    expect(prompt).toContain('Glow Co')
    expect(prompt).toContain('Bright Tone Serum')
    for (const ingredient of INPUT.ingredients) expect(prompt).toContain(ingredient)
    for (const fact of INPUT.flaggedFacts) {
      expect(prompt).toContain(fact.ingredient)
      expect(prompt).toContain(fact.rule)
      expect(prompt).toContain(fact.kind)
    }
  })

  it('throws AnthropicRefusalError when the model refuses', async () => {
    stubFetch(() => messageResponse({ content: [textBlock('I cannot help with that.')], stop_reason: 'refusal' }))

    expect(await caught(make().analyse(INPUT))).toBeInstanceOf(AnthropicRefusalError)
  })

  it('lets AnthropicUnavailableError through when Claude is overloaded', async () => {
    stubFetch(() => errorResponse(529, 'overloaded_error'))

    expect(await caught(make().analyse(INPUT))).toBeInstanceOf(AnthropicUnavailableError)
  })
})

describe('AnthropicProductAnalyst token budgets', () => {
  // Adaptive thinking counts against max_tokens, so the budgets must leave room beyond the answer.
  it('gives analyse 16000 max_tokens', async () => {
    const calls = stubFetch(structured({ concerns: [] }))

    await make().analyse(INPUT)

    expect(calls[0]!.body.max_tokens).toBe(16000)
  })

  it('gives sameProduct 4096 max_tokens', async () => {
    const calls = stubFetch(structured({ same: true }))

    await make().sameProduct(PRODUCT, OTHER)

    expect(calls[0]!.body.max_tokens).toBe(4096)
  })

  it('gives imageShowsProduct 4096 max_tokens', async () => {
    const calls = stubFetch(structured({ matches: true }))

    await make().imageShowsProduct({ bytes: JPEG_BYTES, mediaType: 'image/jpeg' }, PRODUCT)

    expect(calls[0]!.body.max_tokens).toBe(4096)
  })
})

describe('AnthropicProductAnalyst.sameProduct', () => {
  it.each([true, false])('returns %s when the model answers same: %s', async (same) => {
    stubFetch(structured({ same }))

    await expect(make().sameProduct(PRODUCT, OTHER)).resolves.toBe(same)
  })

  it('asks for a closed { same: boolean } json_schema answer naming both products, with no forced tool choice', async () => {
    const calls = stubFetch(structured({ same: true }))

    await make().sameProduct(PRODUCT, OTHER)

    const body = calls[0]!.body
    expect(body.output_config.format.type).toBe('json_schema')
    expect(schemaOf(body).properties.same.type).toBe('boolean')
    assertApiSafe(schemaOf(body))
    expect('tool_choice' in body).toBe(false)
    const prompt = requestText(body)
    for (const text of ['Glow Co', 'Bright Tone Serum', 'Extra Strength', 'Glow Company', 'Brighttone Serum']) {
      expect(prompt).toContain(text)
    }
  })

  it('throws AnthropicRefusalError when the model refuses', async () => {
    stubFetch(() => messageResponse({ content: [textBlock('No.')], stop_reason: 'refusal' }))

    expect(await caught(make().sameProduct(PRODUCT, OTHER))).toBeInstanceOf(AnthropicRefusalError)
  })
})

describe('AnthropicProductAnalyst.imageShowsProduct', () => {
  const image = (mediaType: ProductImage['mediaType'] = 'image/jpeg', bytes = JPEG_BYTES): ProductImage => ({ bytes, mediaType })

  it.each([true, false])('returns %s when the model answers matches: %s', async (matches) => {
    stubFetch(structured({ matches }))

    await expect(make().imageShowsProduct(image(), PRODUCT)).resolves.toBe(matches)
  })

  it.each(['image/jpeg', 'image/png', 'image/webp'] as const)(
    'sends a %s image as a base64 block before the text',
    async (mediaType) => {
      const calls = stubFetch(structured({ matches: true }))

      await make().imageShowsProduct(image(mediaType), PRODUCT)

      const content: Block[] = calls[0]!.body.messages[0].content
      const imageIndex = content.findIndex((block) => block.type === 'image')
      const textIndex = content.findIndex((block) => block.type === 'text')
      expect(imageIndex).toBe(0)
      expect(textIndex).toBeGreaterThan(imageIndex)
      expect(content[imageIndex]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: JPEG_BASE64 },
      })
    },
  )

  it('encodes a large image completely, byte for byte', async () => {
    const calls = stubFetch(structured({ matches: true }))
    const bytes = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7 + (i >> 8)) % 256)

    await make().imageShowsProduct(image('image/png', bytes), PRODUCT)

    const data: string = calls[0]!.body.messages[0].content[0].source.data
    const decoded = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    expect(decoded.length).toBe(bytes.length)
    expect(decoded.every((byte, i) => byte === bytes[i])).toBe(true)
  })

  it('asks for a closed { matches: boolean } json_schema answer naming the product, with no forced tool choice', async () => {
    const calls = stubFetch(structured({ matches: true }))

    await make().imageShowsProduct(image(), PRODUCT)

    const body = calls[0]!.body
    expect(body.output_config.format.type).toBe('json_schema')
    expect(schemaOf(body).properties.matches.type).toBe('boolean')
    assertApiSafe(schemaOf(body))
    expect('tool_choice' in body).toBe(false)
    expect(body.model).toBe(MODEL)
    const prompt = requestText(body)
    expect(prompt).toContain('Glow Co')
    expect(prompt).toContain('Bright Tone Serum')
  })

  it('throws AnthropicRefusalError when the model refuses', async () => {
    stubFetch(() => messageResponse({ content: [textBlock('No.')], stop_reason: 'refusal' }))

    expect(await caught(make().imageShowsProduct(image(), PRODUCT))).toBeInstanceOf(AnthropicRefusalError)
  })
})

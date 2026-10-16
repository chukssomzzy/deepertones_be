import { describe, expect, it } from 'vitest'
import { AnthropicClient } from '../anthropic/anthropic.client'
import { AnthropicRefusalError, AnthropicRequestError, AnthropicUnavailableError } from '../anthropic/anthropic.provider'
import {
  API_KEY,
  type Block,
  caught,
  errorResponse,
  MODEL,
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

/** An analyst over a client whose HTTP goes through `fetch`; the returned `calls` records the requests. */
const analystOver = (...responders: Parameters<typeof stubFetch>) => {
  const { calls, fetch } = stubFetch(...responders)
  const analyst = new AnthropicProductAnalyst(new AnthropicClient({ apiKey: API_KEY, model: MODEL, baseURL: 'https://anthropic.example', fetch }))
  return { calls, analyst }
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

describe('AnthropicProductAnalyst.analyse', () => {
  it('returns the concerns from the structured answer', async () => {
    const { analyst } = analystOver(structured({ concerns: [CONCERN] }))

    await expect(analyst.analyse(INPUT)).resolves.toEqual([CONCERN])
  })

  it('returns no concerns when the model returns none', async () => {
    const { analyst } = analystOver(structured({ concerns: [] }))

    await expect(analyst.analyse({ ...INPUT, flaggedFacts: [] })).resolves.toEqual([])
  })

  it('requests a json_schema output with no forced tool choice, using the configured model', async () => {
    const { calls, analyst } = analystOver(structured({ concerns: [] }))

    await analyst.analyse(INPUT)

    const body = calls[0]!.body
    expect(body.output_config.format.type).toBe('json_schema')
    expect('tool_choice' in body).toBe(false)
    expect(body.model).toBe(MODEL)
    expect(body.max_tokens).toBeGreaterThan(0)
  })

  it('builds the schema enums from the vocabularies it was given, and nothing else', async () => {
    const { calls, analyst } = analystOver(structured({ concerns: [] }))
    const input = { ...INPUT, kinds: ['kind-a', 'kind-b'], severities: ['sev-x'], traits: ['trait-1', 'trait-2', 'trait-3'] }

    await analyst.analyse(input)

    const schema = schemaOf(calls[0]!.body)
    const concern = schema.properties.concerns.items.properties
    expect(concern.kind.enum).toEqual(['kind-a', 'kind-b'])
    expect(concern.severity.enum).toEqual(['sev-x'])
    expect(concern.traits.items.enum).toEqual(['trait-1', 'trait-2', 'trait-3'])
  })

  it('uses a schema the API accepts: every object closed, no unsupported constraints', async () => {
    const { calls, analyst } = analystOver(structured({ concerns: [] }))

    await analyst.analyse(INPUT)

    const schema = schemaOf(calls[0]!.body)
    expect(schema.type).toBe('object')
    assertApiSafe(schema)
  })

  it('puts the product, its ingredients and every flagged fact in the prompt', async () => {
    const { calls, analyst } = analystOver(structured({ concerns: [] }))

    await analyst.analyse(INPUT)

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
    const { analyst } = analystOver(() => messageResponse({ content: [textBlock('I cannot help with that.')], stop_reason: 'refusal' }))

    expect(await caught(analyst.analyse(INPUT))).toBeInstanceOf(AnthropicRefusalError)
  })

  it('throws AnthropicRequestError when the answer does not match the schema built from the vocabularies', async () => {
    const { analyst } = analystOver(structured({ concerns: [{ ...CONCERN, kind: 'not-a-known-kind' }] }))

    expect(await caught(analyst.analyse(INPUT))).toBeInstanceOf(AnthropicRequestError)
  })

  it('lets AnthropicUnavailableError through when Claude is overloaded', async () => {
    const { analyst } = analystOver(() => errorResponse(529, 'overloaded_error'))

    expect(await caught(analyst.analyse(INPUT))).toBeInstanceOf(AnthropicUnavailableError)
  })
})

describe('AnthropicProductAnalyst token budgets', () => {
  // Adaptive thinking counts against max_tokens, so the budgets must leave room beyond the answer.
  it('gives analyse 16000 max_tokens', async () => {
    const { calls, analyst } = analystOver(structured({ concerns: [] }))

    await analyst.analyse(INPUT)

    expect(calls[0]!.body.max_tokens).toBe(16000)
  })

  it('gives sameProduct 2048 max_tokens', async () => {
    const { calls, analyst } = analystOver(structured({ same: true }))

    await analyst.sameProduct(PRODUCT, OTHER)

    expect(calls[0]!.body.max_tokens).toBe(2048)
  })

  it('gives imageShowsProduct 2048 max_tokens', async () => {
    const { calls, analyst } = analystOver(structured({ matches: true }))

    await analyst.imageShowsProduct({ bytes: JPEG_BYTES, mediaType: 'image/jpeg' }, PRODUCT)

    expect(calls[0]!.body.max_tokens).toBe(2048)
  })
})

describe('AnthropicProductAnalyst.sameProduct', () => {
  it.each([true, false])('returns %s when the model answers same: %s', async (same) => {
    const { analyst } = analystOver(structured({ same }))

    await expect(analyst.sameProduct(PRODUCT, OTHER)).resolves.toBe(same)
  })

  it('asks for a closed { same: boolean } json_schema answer naming both products, with no forced tool choice', async () => {
    const { calls, analyst } = analystOver(structured({ same: true }))

    await analyst.sameProduct(PRODUCT, OTHER)

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
    const { analyst } = analystOver(() => messageResponse({ content: [textBlock('No.')], stop_reason: 'refusal' }))

    expect(await caught(analyst.sameProduct(PRODUCT, OTHER))).toBeInstanceOf(AnthropicRefusalError)
  })
})

describe('AnthropicProductAnalyst.imageShowsProduct', () => {
  const image = (mediaType: ProductImage['mediaType'] = 'image/jpeg', bytes = JPEG_BYTES): ProductImage => ({ bytes, mediaType })

  it.each([true, false])('returns %s when the model answers matches: %s', async (matches) => {
    const { analyst } = analystOver(structured({ matches }))

    await expect(analyst.imageShowsProduct(image(), PRODUCT)).resolves.toBe(matches)
  })

  it.each(['image/jpeg', 'image/png', 'image/webp'] as const)(
    'sends a %s image as a base64 block before the text',
    async (mediaType) => {
      const { calls, analyst } = analystOver(structured({ matches: true }))

      await analyst.imageShowsProduct(image(mediaType), PRODUCT)

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
    const { calls, analyst } = analystOver(structured({ matches: true }))
    const bytes = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7 + (i >> 8)) % 256)

    await analyst.imageShowsProduct(image('image/png', bytes), PRODUCT)

    const data: string = calls[0]!.body.messages[0].content[0].source.data
    const decoded = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    expect(decoded.length).toBe(bytes.length)
    expect(decoded.every((byte, i) => byte === bytes[i])).toBe(true)
  })

  it('asks for a closed { matches: boolean } json_schema answer naming the product, with no forced tool choice', async () => {
    const { calls, analyst } = analystOver(structured({ matches: true }))

    await analyst.imageShowsProduct(image(), PRODUCT)

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
    const { analyst } = analystOver(() => messageResponse({ content: [textBlock('No.')], stop_reason: 'refusal' }))

    expect(await caught(analyst.imageShowsProduct(image(), PRODUCT))).toBeInstanceOf(AnthropicRefusalError)
  })
})

import { describe, expect, it } from 'vitest'
import { AI_JOBS, AiBudgetExceededError, type AiJob } from '../anthropic/ai-spend.provider'
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
import { AnthropicNameSplitter } from './anthropic.name-splitter'

const ROUTED_TO = 'claude-haiku-5-5'
const MAX_FIELD = 120
const NOT_A_PRODUCT = { kind: 'not-a-product' }
const TYPED = 'cerave hydrating facial cleanser'

/** The structured answer for a name the model split; a test overrides only what it is about. */
const product = (overrides: Record<string, unknown> = {}) => ({
  kind: 'product',
  brand: 'CeraVe',
  name: 'Hydrating Facial Cleanser',
  variant: 'Normal to Dry Skin',
  category: 'skin',
  ...overrides,
})

/** Every job on MODEL, except `routed`, which goes to ROUTED_TO: whichever job the adapter uses shows in the model it sends. */
const splitterWith = (fetch: typeof globalThis.fetch, ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS }), routed?: AiJob) =>
  new AnthropicNameSplitter(
    new AnthropicClient({
      apiKey: API_KEY,
      models: routed ? { ...MODELS, [routed]: ROUTED_TO } : MODELS,
      ledger,
      baseURL: 'https://anthropic.example',
      fetch,
    }),
  )

/** A splitter over a client whose HTTP goes through `fetch`; the returned `calls` records the requests. */
const splitterOver = (...responders: Parameters<typeof stubFetch>) => {
  const { calls, fetch } = stubFetch(...responders)
  return { calls, splitter: splitterWith(fetch) }
}

const structured = (value: unknown, stop_reason = 'end_turn') => () => messageResponse({ content: [textBlock(JSON.stringify(value))], stop_reason })

/** The words the model was told to split: every part it answers with, as someone typing that product would write it. */
const typedFor = (answer: Record<string, unknown>) => [answer.brand, answer.name, answer.variant].filter((part): part is string => typeof part === 'string').join(' ')
/**
 * A splitter over the model answering `answer`, asked about the text a user would have typed for it (so the answer's words are all in the text,
 * which the splitter requires). `split()` with no text asks about that; a test about the typed text itself passes its own.
 */
const answering = (answer: Record<string, unknown>) => {
  const { calls, splitter } = splitterOver(structured(answer))
  return { calls, splitter: { split: (text: string = typedFor(answer)) => splitter.split(text) } }
}

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

describe('the split-name AI job', () => {
  it('is one of the jobs the AI spend ledger and the client know', () => {
    expect(AI_JOBS).toContain('split-name')
  })
})

describe('AnthropicNameSplitter request', () => {
  it('sends the typed text exactly as typed, as a text block in the user message, with 4096 max_tokens and no forced tool choice', async () => {
    const { calls, splitter } = splitterOver(structured(product()))
    const typed = "  L'Oréal   Revitalift Crème SPF 50+  "

    await splitter.split(typed)

    const body = calls[0]!.body
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
    // The message content may be one string or a list of blocks; either way it is text, and it holds the typed text untouched.
    const raw: string | Block[] = body.messages[0].content
    const content: Block[] = typeof raw === 'string' ? [{ type: 'text', text: raw }] : raw
    expect(content.every((block) => block.type === 'text')).toBe(true)
    expect(content.map((block) => block.text).join('\n')).toContain(typed)
    expect(body.max_tokens).toBe(4096)
    expect(body.output_config.format.type).toBe('json_schema')
    expect('tool_choice' in body).toBe(false)
  })

  it('keeps the typed text out of the system prompt, so the instructions do not carry it', async () => {
    const { calls, splitter } = splitterOver(structured(product()))

    await splitter.split('zzqx-unique-typed-text')

    expect(JSON.stringify(calls[0]!.body.system)).not.toContain('zzqx-unique-typed-text')
  })

  it('asks for a closed json_schema answer the API accepts, discriminated by `kind` (product or not-a-product), with the five categories', async () => {
    const { calls, splitter } = splitterOver(structured(product()))

    await splitter.split(TYPED)

    const schema = schemaOf(calls[0]!.body)
    expect(schema.type).toBe('object')
    assertApiSafe(schema)
    // Not `classification` (the recognizer's) nor `readable` (the label reader's): the request is told apart from theirs by its `kind`.
    expect([...schema.properties.kind.enum].sort()).toEqual(['not-a-product', 'product'])
    expect(schema.properties).not.toHaveProperty('classification')
    expect([...schema.properties.category.enum].sort()).toEqual(['body', 'hair', 'makeup', 'other', 'skin'])
    for (const field of ['brand', 'name', 'variant']) expect(schema.properties[field].type, field).toBe('string')
    expect(schema.required).toContain('kind')
  })

  it('tells the model the typed text is user-supplied data whose instructions must be ignored, and never to invent a brand or name', async () => {
    const { calls, splitter } = splitterOver(structured(product()))

    await splitter.split(TYPED)

    const prompt = requestText(calls[0]!.body)
    expect(prompt).toMatch(/user-supplied/i)
    expect(prompt).toMatch(/ignore/i)
    expect(prompt).toMatch(/instructions/i)
    expect(prompt).toContain('not-a-product')
    expect(prompt).toMatch(/never (guess|invent)|do not (guess|invent)/i)
  })
})

describe('AnthropicNameSplitter job routing and cost', () => {
  it('asks Claude as the split-name job and uses the model configured for it', async () => {
    const { calls, fetch } = stubFetch(structured(product()))

    await splitterWith(fetch, undefined, 'split-name').split(TYPED)

    expect(calls[0]!.body.model).toBe(ROUTED_TO)
  })

  it('does not use the model of any other job', async () => {
    const { calls, fetch } = stubFetch(structured(product()))
    const others = (Object.keys(MODELS) as AiJob[]).filter((job) => job !== 'split-name')

    for (const other of others) await splitterWith(fetch, undefined, other).split(TYPED)

    expect(calls.map((c) => c.body.model)).toEqual(others.map(() => MODEL))
  })

  it('records its call on the ledger under the split-name job', async () => {
    const { fetch } = stubFetch(structured(product()))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await splitterWith(fetch, ledger).split(TYPED)

    expect(ledger.entries.map((e) => [e.job, e.model, e.status])).toEqual([['split-name', MODEL, 'settled']])
  })

  it('makes exactly one request per split', async () => {
    const { calls, splitter } = splitterOver(structured(product()))

    await splitter.split(TYPED)

    expect(calls).toHaveLength(1)
  })

  it('throws AiBudgetExceededError, sending nothing, when the spend cap would be passed', async () => {
    const { calls, fetch } = stubFetch(structured(product()))
    const ledger = new MemoryAiSpendLedger({ capMicros: 1 })

    const error = await caught(splitterWith(fetch, ledger).split(TYPED))

    expect(error).toBeInstanceOf(AiBudgetExceededError)
    expect(calls).toHaveLength(0)
  })
})

describe('AnthropicNameSplitter answers', () => {
  it('returns the product with its brand, name, variant and category', async () => {
    const { splitter } = answering(product())

    await expect(splitter.split()).resolves.toStrictEqual({
      kind: 'product',
      brand: 'CeraVe',
      name: 'Hydrating Facial Cleanser',
      variant: 'Normal to Dry Skin',
      category: 'skin',
    })
  })

  it.each(['skin', 'hair', 'body', 'makeup', 'other'])('keeps the category %s', async (category) => {
    const { splitter } = answering(product({ category }))

    await expect(splitter.split()).resolves.toMatchObject({ kind: 'product', category })
  })

  it('trims brand, name and variant', async () => {
    const { splitter } = answering(product({ brand: '  Glow Co ', name: '\tBright Tone Serum\n', variant: ' Extra Strength  ' }))

    await expect(splitter.split()).resolves.toMatchObject({ brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Extra Strength' })
  })

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['missing', undefined],
  ])('leaves the variant out when it is %s', async (_label, variant) => {
    const { splitter } = answering(product({ variant }))

    const result = await splitter.split()

    expect(result).toMatchObject({ kind: 'product', brand: 'CeraVe', name: 'Hydrating Facial Cleanser' })
    expect(result).not.toHaveProperty('variant')
  })

  it('returns only { kind: "not-a-product" } when the model says the text is not a product name, even if it also wrote product fields', async () => {
    const { splitter } = answering(product({ kind: 'not-a-product' }))

    await expect(splitter.split('hello there')).resolves.toStrictEqual(NOT_A_PRODUCT)
  })

  it.each([
    ['an empty brand', { brand: '' }],
    ['a brand of only spaces', { brand: '  \t ' }],
    ['no brand', { brand: undefined }],
    ['an empty name', { name: '' }],
    ['a name of only spaces', { name: '   ' }],
    ['no name', { name: undefined }],
    ['a category outside the five', { category: 'perfume' }],
    ['no category', { category: undefined }],
  ])('treats a product with %s as not-a-product', async (_label, overrides) => {
    const { splitter } = answering(product(overrides))

    await expect(splitter.split()).resolves.toStrictEqual(NOT_A_PRODUCT)
  })
})

describe('AnthropicNameSplitter length bounds', () => {
  const fields = ['brand', 'name', 'variant'] as const

  it.each(fields)('accepts a %s of exactly 120 characters', async (field) => {
    const value = 'x'.repeat(MAX_FIELD)
    const { splitter } = answering(product({ [field]: value }))

    await expect(splitter.split()).resolves.toMatchObject({ kind: 'product', [field]: value })
  })

  it.each(fields)('treats a %s of 121 characters as not-a-product', async (field) => {
    const { splitter } = answering(product({ [field]: 'x'.repeat(MAX_FIELD + 1) }))

    await expect(splitter.split()).resolves.toStrictEqual(NOT_A_PRODUCT)
  })

  it.each(fields)('measures a %s after trimming, so 120 characters padded with spaces is accepted', async (field) => {
    const value = 'x'.repeat(MAX_FIELD)
    const { splitter } = answering(product({ [field]: `  ${value}  ` }))

    await expect(splitter.split()).resolves.toMatchObject({ kind: 'product', [field]: value })
  })
})

describe('AnthropicNameSplitter links and markup', () => {
  const fields = ['brand', 'name', 'variant'] as const
  const bad = [
    'https://evil.example/buy',
    'http://evil.example',
    'Visit www.evil.example',
    'WWW.EVIL.EXAMPLE',
    'Serum <b>bold</b>',
    '<script>alert(1)</script>',
    'Serum </div>',
  ]
  const cases = fields.flatMap((field) => bad.map((value) => [field, value] as const))

  it.each(cases)('treats a %s of %j as not-a-product', async (field, value) => {
    const { splitter } = answering(product({ [field]: value }))

    await expect(splitter.split()).resolves.toStrictEqual(NOT_A_PRODUCT)
  })

  it.each([['SPF < 30 Day Cream'], ['Retinol <1% Night Serum'], ['Vitamin C + E (10%)'], ["L'Oréal Paris"]])('accepts ordinary text such as %j', async (name) => {
    const { splitter } = answering(product({ name }))

    await expect(splitter.split()).resolves.toMatchObject({ kind: 'product', name })
  })
})

describe('AnthropicNameSplitter hidden characters', () => {
  const fields = ['brand', 'name', 'variant'] as const
  const hidden = [
    ['a NUL', 'Glow\u0000 Co'],
    ['a newline', 'Glow\nCo'],
    ['a right-to-left override (U+202E)', 'Glow‮Co'],
    ['a zero-width space (U+200B)', 'Glow​ Co'],
    ['a soft hyphen (U+00AD)', 'Glow­Co'],
  ] as const
  const cases = fields.flatMap((field) => hidden.map(([label, value]) => [field, label, value] as const))

  it.each(cases)('treats a %s with %s as not-a-product', async (field, _label, value) => {
    const { splitter } = answering(product({ [field]: value }))

    await expect(splitter.split()).resolves.toStrictEqual(NOT_A_PRODUCT)
  })

  it('accepts accented and non-Latin text, which has no hidden characters', async () => {
    const { splitter } = answering(product({ brand: 'Nuxe Crème', name: 'Huile Prodigieuse® 油', variant: 'Néroli' }))

    await expect(splitter.split()).resolves.toMatchObject({ brand: 'Nuxe Crème', name: 'Huile Prodigieuse® 油', variant: 'Néroli' })
  })
})

describe('AnthropicNameSplitter: only words the user typed', () => {
  const asked = (typed: string, answer: Record<string, unknown>) => splitterOver(structured(answer)).splitter.split(typed)

  it('treats a word the model added that was not typed as not-a-product: "facial" was not in "cerave hydrating cleanser"', async () => {
    await expect(asked('cerave hydrating cleanser', product({ variant: '' }))).resolves.toStrictEqual(NOT_A_PRODUCT)
  })

  it.each([
    ['brand', { brand: 'CeraVe Paris' }],
    ['name', { name: 'Hydrating Cleanser Gel' }],
    ['variant', { variant: 'Night' }],
  ])('treats a word in the %s that was not typed as not-a-product', async (_field, over) => {
    await expect(asked('cerave hydrating cleanser', product({ name: 'Hydrating Cleanser', variant: '', ...over }))).resolves.toStrictEqual(NOT_A_PRODUCT)
  })

  it('accepts every word typed, in the typed order and with the model\'s own case', async () => {
    await expect(asked('cerave hydrating facial cleanser', product({ variant: '' }))).resolves.toStrictEqual({
      kind: 'product',
      brand: 'CeraVe',
      name: 'Hydrating Facial Cleanser',
      category: 'skin',
    })
  })

  it('does not mind case, accents or punctuation: they are normalised before the words are compared', async () => {
    const answer = product({ brand: "L'Oréal Paris", name: 'Revitalift Crème', variant: 'SPF 50+' })

    await expect(asked('LOREAL, PARIS - revitalift creme (spf 50 plus)', answer)).resolves.toMatchObject({ kind: 'product', brand: "L'Oréal Paris", name: 'Revitalift Crème', variant: 'SPF 50+' })
    await expect(asked("l'oréal paris revitalift crème spf 50+", answer)).resolves.toMatchObject({ kind: 'product' })
  })

  it('reads "&" as "and" and "+" as "plus", as the catalog does', async () => {
    await expect(asked('johnson and johnson baby oil', product({ brand: 'Johnson & Johnson', name: 'Baby Oil', variant: '' }))).resolves.toMatchObject({ kind: 'product' })
    await expect(asked('dove men+care', product({ brand: 'Dove', name: 'Men+Care', variant: '' }))).resolves.toMatchObject({ kind: 'product' })
  })

  it('lets the user have typed more than the model kept: extra typed words are not a problem', async () => {
    await expect(asked('please add my cerave hydrating facial cleanser for dry skin', product({ variant: '' }))).resolves.toMatchObject({
      kind: 'product',
      brand: 'CeraVe',
      name: 'Hydrating Facial Cleanser',
    })
  })

  it('lets the model reorder what was typed', async () => {
    await expect(asked('hydrating facial cleanser cerave', product({ variant: '' }))).resolves.toMatchObject({ kind: 'product' })
  })

  describe('spacing differences', () => {
    // Each of brand, name and variant is normalised and stripped of spaces, and must be a substring of the typed text normalised and stripped the same way.
    it('accepts a brand the model joined or split differently from the typed words: "shea moisture" for SheaMoisture', async () => {
      await expect(asked('shea moisture raw shea butter', product({ brand: 'SheaMoisture', name: 'Raw Shea Butter', variant: '' }))).resolves.toMatchObject({
        kind: 'product',
        brand: 'SheaMoisture',
        name: 'Raw Shea Butter',
      })
      await expect(asked('SheaMoisture raw shea butter', product({ brand: 'Shea Moisture', name: 'Raw Shea Butter', variant: '' }))).resolves.toMatchObject({ kind: 'product' })
    })

    it('accepts a variant spaced differently from the typed one: "50ml" typed, "50 ml" answered', async () => {
      await expect(asked('cerave cleanser 50ml', product({ name: 'Cleanser', variant: '50 ml' }))).resolves.toMatchObject({ kind: 'product', name: 'Cleanser', variant: '50 ml' })
    })

    it('still rejects a word the user did not type, spacing aside: "facial" in "hydrating facial cleanser"', async () => {
      await expect(asked('cerave hydrating cleanser', product({ variant: '' }))).resolves.toStrictEqual(NOT_A_PRODUCT)
    })

    it('rejects a brand the model made up', async () => {
      await expect(asked('hydrating facial cleanser', product({ brand: 'CeraVe', variant: '' }))).resolves.toStrictEqual(NOT_A_PRODUCT)
    })

    it('rejects a typo the model corrected: "cleansr" typed, "Cleanser" answered', async () => {
      await expect(asked('cerave hydrating cleansr', product({ name: 'Hydrating Cleanser', variant: '' }))).resolves.toStrictEqual(NOT_A_PRODUCT)
    })

    it('rejects a variant that was not typed', async () => {
      await expect(asked('cerave night cleanser', product({ name: 'Cleanser', variant: 'Day' }))).resolves.toStrictEqual(NOT_A_PRODUCT)
    })

    it.each([
      ['a brand', { brand: '!!' }],
      ['a name', { name: ' - ' }],
    ])('rejects %s that is nothing once normalised, though nothing is a substring of any text', async (_label, over) => {
      await expect(asked('cerave !! - cleanser', product({ variant: '', ...over }))).resolves.toStrictEqual(NOT_A_PRODUCT)
    })
  })

  it('does not hold the category to the typed words: it is not part of the name', async () => {
    await expect(asked('cerave hydrating facial cleanser', product({ variant: '', category: 'hair' }))).resolves.toMatchObject({ kind: 'product', category: 'hair' })
  })

  it('still answers not-a-product when the model says so, whatever was typed', async () => {
    await expect(asked('anything', product({ kind: 'not-a-product' }))).resolves.toStrictEqual(NOT_A_PRODUCT)
  })
})

describe('AnthropicNameSplitter errors', () => {
  it('throws AnthropicRefusalError when the model refuses', async () => {
    const { splitter } = splitterOver(() => messageResponse({ content: [textBlock('I cannot help with that.')], stop_reason: 'refusal' }))

    expect(await caught(splitter.split(TYPED))).toBeInstanceOf(AnthropicRefusalError)
  })

  it('lets AnthropicUnavailableError through when Claude is overloaded', async () => {
    const { splitter } = splitterOver(() => errorResponse(529, 'overloaded_error'))

    expect(await caught(splitter.split(TYPED))).toBeInstanceOf(AnthropicUnavailableError)
  })
})

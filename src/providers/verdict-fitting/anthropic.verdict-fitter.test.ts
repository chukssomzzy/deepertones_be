import { describe, expect, it } from 'vitest'
import { verdictFitterFitVerdictPrompt } from '../../prompts/prompts.generated'
import { AI_JOBS, AiBudgetExceededError, type AiJob } from '../anthropic/ai-spend.provider'
import { AnthropicClient } from '../anthropic/anthropic.client'
import { AnthropicConfigError, AnthropicRefusalError, AnthropicRequestError, AnthropicUnavailableError } from '../anthropic/anthropic.provider'
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
import { AnthropicVerdictFitter } from './anthropic.verdict-fitter'
import type { FitRequest, FitResult } from './verdict-fitter.provider'

const ROUTED_TO = 'claude-haiku-5-5'

/**
 * A small shelf: a steroid cream and a prescribed cream the floor fixed, and three products it left open, two of which clash (a retinoid and an acid).
 * Every name is invented, none is from an eval set.
 */
const REQUEST: FitRequest = {
  goal: { id: 'fade-dark-marks', skinConcerns: ['hd_age_spot', 'hd_redness'] },
  skinType: 'combination',
  scan: [
    { concern: 'hd_age_spot', level: 'some' },
    { concern: 'hd_redness', level: 'a-little' },
  ],
  shelf: [
    {
      id: 'steroid-1',
      brand: 'Brand A',
      name: 'Clobetasol cream',
      variant: null,
      step: 'treat',
      ingredients: ['Aqua', 'Clobetasol Propionate'],
      cautions: ['restricted-substance'],
      skinConcerns: [],
      floor: { status: 'fixed', group: 'likely-the-problem' },
    },
    {
      id: 'rx-1',
      brand: 'Brand B',
      name: 'Prescribed cream',
      variant: '0.05%',
      step: 'treat',
      ingredients: ['Aqua', 'Tretinoin'],
      cautions: [],
      skinConcerns: ['hd_age_spot'],
      floor: { status: 'fixed', group: 'prescribed' },
    },
    {
      id: 'retinol-1',
      brand: 'Brand C',
      name: 'Retinol night serum',
      variant: null,
      step: 'treat',
      ingredients: ['Aqua', 'Retinol', 'Glycerin'],
      cautions: ['irritation', 'pregnancy-caution'],
      skinConcerns: ['hd_age_spot', 'hd_texture'],
      floor: { status: 'open' },
    },
    {
      id: 'acid-1',
      brand: null,
      name: 'Glycolic toner',
      variant: 'daily',
      step: 'treat',
      ingredients: ['Aqua', 'Glycolic Acid'],
      cautions: ['irritation'],
      skinConcerns: ['hd_texture'],
      floor: { status: 'open' },
    },
    {
      id: 'moist-1',
      brand: 'Brand D',
      name: 'Barrier moisturiser',
      variant: null,
      step: 'moisturise',
      ingredients: ['Aqua', 'Glycerin', 'Ceramide NP'],
      cautions: [],
      skinConcerns: ['hd_moisture'],
      floor: { status: 'open' },
    },
  ],
  clashes: [{ ids: ['retinol-1', 'acid-1'], groups: ['retinoid', 'exfoliating-acid'] }],
}

/** A request with no skin type and no face scan, and no clash: the guest who skipped the face photo. */
const GUEST_REQUEST: FitRequest = {
  ...REQUEST,
  skinType: null,
  scan: null,
  shelf: REQUEST.shelf.filter((p) => p.id === 'moist-1'),
  clashes: [],
}

/** What the model is meant to answer for REQUEST, and what the adapter must hand back: one entry per open product, one per clash. */
const RESULT: FitResult = {
  products: [
    { id: 'retinol-1', label: 'helping', reason: 'Retinol works on dark marks and uneven texture, which are the goal concerns.' },
    { id: 'acid-1', label: 'blocking', reason: 'Glycolic acid can irritate skin that marks easily, which holds the goal back.' },
    { id: 'moist-1', label: 'redundant', reason: 'Another moisturiser on the shelf already does this job.' },
  ],
  clashes: [{ ids: ['retinol-1', 'acid-1'], reduceId: 'acid-1' }],
}

const GUEST_RESULT: FitResult = { products: [{ id: 'moist-1', label: 'helping', reason: 'Glycerin and ceramide keep skin comfortable.' }], clashes: [] }

/** Every job on MODEL, except `routed`, which goes to ROUTED_TO: whichever job the adapter uses shows in the model it sends. */
const fitterWith = (fetch: typeof globalThis.fetch, ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS }), routed?: AiJob) =>
  new AnthropicVerdictFitter(
    new AnthropicClient({
      apiKey: API_KEY,
      models: { ...MODELS, ...(routed ? { [routed]: ROUTED_TO } : {}) },
      ledger,
      baseURL: 'https://anthropic.example',
      fetch,
    }),
  )

/** A fetch whose model answers `result`; `calls` records the requests. */
const answeringFetch = (result: unknown) => stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(result))] }))

/** A fitter whose model answers `result` (any value, so a test can break it). */
const fitterAnswering = (result: unknown = RESULT) => {
  const stub = answeringFetch(result)
  return { ...stub, fitter: fitterWith(stub.fetch) }
}

/** A fitter over a client whose HTTP goes through `fetch`; the returned `calls` records the requests. */
const fitterOver = (...responders: Parameters<typeof stubFetch>) => {
  const { calls, fetch } = stubFetch(...responders)
  return { calls, fitter: fitterWith(fetch) }
}

const userText = (body: any): string => {
  expect(body.messages).toHaveLength(1)
  expect(body.messages[0].role).toBe('user')
  const raw: string | Block[] = body.messages[0].content
  const content: Block[] = typeof raw === 'string' ? [{ type: 'text', text: raw }] : raw
  expect(content.every((block) => block.type === 'text')).toBe(true)
  return content.map((block) => block.text).join('')
}

describe('the fit-verdict AI job', () => {
  it('is one of the jobs the AI spend ledger and the client know', () => {
    expect(AI_JOBS).toContain('fit-verdict')
  })

  it('is the job the verdict fitter prompt runs under', () => {
    expect(verdictFitterFitVerdictPrompt.job).toBe('fit-verdict')
  })
})

describe('AnthropicVerdictFitter request', () => {
  it('sends the verdict fitter prompt as the system prompt, with no forced tool choice', async () => {
    const { calls, fitter } = fitterAnswering()

    await fitter.fit(REQUEST)

    expect(JSON.stringify(calls[0]!.body.system)).toContain(JSON.stringify(verdictFitterFitVerdictPrompt.text).slice(1, -1))
    expect('tool_choice' in calls[0]!.body).toBe(false)
  })

  it('sends one user message that carries the whole request as JSON: goal, skin type, scan levels, every shelf product with its floor status, and the clash pairs', async () => {
    const { calls, fitter } = fitterAnswering()

    await fitter.fit(REQUEST)

    const text = userText(calls[0]!.body)
    // Whatever words lead in, the JSON is everything from the first brace to the end.
    expect(JSON.parse(text.slice(text.indexOf('{')))).toEqual(REQUEST)
  })

  it('sends a guest request, with no skin type and no scan, as it is', async () => {
    const { calls, fitter } = fitterAnswering(GUEST_RESULT)

    await fitter.fit(GUEST_REQUEST)

    const text = userText(calls[0]!.body)
    expect(JSON.parse(text.slice(text.indexOf('{')))).toEqual(GUEST_REQUEST)
  })

  it('keeps the shelf out of the system prompt, so the instructions do not carry it', async () => {
    const { calls, fitter } = fitterAnswering()

    // Renames one product and keeps the whole shelf, because the answer must still name every open product.
    await fitter.fit({ ...REQUEST, shelf: REQUEST.shelf.map((p, i) => (i === 2 ? { ...p, name: 'zzqx-unique-product-name' } : p)) })

    expect(JSON.stringify(calls[0]!.body.system)).not.toContain('zzqx-unique-product-name')
    expect(requestText(calls[0]!.body)).toContain('zzqx-unique-product-name')
  })

  it('asks for a json_schema structured output that is an object, and never uses oneOf, which structured outputs do not document', async () => {
    const { calls, fitter } = fitterAnswering()

    await fitter.fit(REQUEST)

    const format = calls[0]!.body.output_config.format
    expect(format.type).toBe('json_schema')
    expect(format.schema).toEqual(expect.objectContaining({ type: 'object' }))
    expect(JSON.stringify(format.schema)).not.toContain('"oneOf"')
  })

  it('asks for exactly the fields the FitResult has: products and clashes, both required, nothing else allowed', async () => {
    const { calls, fitter } = fitterAnswering()

    await fitter.fit(REQUEST)

    const top = calls[0]!.body.output_config.format.schema
    expect(Object.keys(top.properties).sort()).toEqual(['clashes', 'products'])
    expect([...top.required].sort()).toEqual(['clashes', 'products'])
    expect(top.additionalProperties).toBe(false)
  })

  it('makes exactly one request per shelf', async () => {
    const { calls, fitter } = fitterAnswering()

    await fitter.fit(REQUEST)

    expect(calls).toHaveLength(1)
  })
})

describe('AnthropicVerdictFitter answers', () => {
  it('returns the label and reason of every open product, and the product to reduce for the clash, as the FitResult has them', async () => {
    const { fitter } = fitterAnswering(RESULT)

    await expect(fitter.fit(REQUEST)).resolves.toStrictEqual(RESULT)
  })

  it('returns each of the three labels as the model gave it', async () => {
    const { fitter } = fitterAnswering(RESULT)

    const result = await fitter.fit(REQUEST)

    expect(result.products.map((p) => [p.id, p.label])).toEqual([
      ['retinol-1', 'helping'],
      ['acid-1', 'blocking'],
      ['moist-1', 'redundant'],
    ])
  })

  it('answers a guest request (no skin type, no scan, no clash) with an empty clash list', async () => {
    const { fitter } = fitterAnswering(GUEST_RESULT)

    await expect(fitter.fit(GUEST_REQUEST)).resolves.toStrictEqual(GUEST_RESULT)
  })

  it('accepts either member of the clashing pair as the one to reduce', async () => {
    for (const reduceId of ['retinol-1', 'acid-1']) {
      const answer = { ...RESULT, clashes: [{ ids: ['retinol-1', 'acid-1'], reduceId }] }

      await expect(fitterAnswering(answer).fitter.fit(REQUEST)).resolves.toStrictEqual(answer)
    }
  })

  // The spec: "if the judge fails to name one, the floor reduces by a fixed tie-break". So a pair left out is the floor's to settle, not an error.
  it('returns an answer that names no product to reduce for a pair, leaving that pair to the floor', async () => {
    const answer: FitResult = { ...RESULT, clashes: [] }

    await expect(fitterAnswering(answer).fitter.fit(REQUEST)).resolves.toStrictEqual(answer)
  })
})

describe('AnthropicVerdictFitter job routing and cost', () => {
  it('asks Claude as the fit-verdict job and uses the model configured for it', async () => {
    const { calls, fetch } = answeringFetch(RESULT)

    await fitterWith(fetch, undefined, 'fit-verdict').fit(REQUEST)

    expect(calls[0]!.body.model).toBe(ROUTED_TO)
  })

  it('does not use the model of any other job', async () => {
    const { calls, fetch } = answeringFetch(RESULT)
    const others = AI_JOBS.filter((job) => job !== 'fit-verdict')

    for (const other of others) await fitterWith(fetch, undefined, other).fit(REQUEST)

    expect(calls.map((c) => c.body.model)).toEqual(others.map(() => MODEL))
  })

  it('records its call on the ledger under the fit-verdict job', async () => {
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })
    const stub = answeringFetch(RESULT)

    await fitterWith(stub.fetch, ledger).fit(REQUEST)

    expect(ledger.entries.map((e) => [e.job, e.model, e.status])).toEqual([['fit-verdict', MODEL, 'settled']])
  })

  it('throws AiBudgetExceededError, sending nothing, when the spend cap would be passed', async () => {
    const { calls, fetch } = answeringFetch(RESULT)

    const error = await caught(fitterWith(fetch, new MemoryAiSpendLedger({ capMicros: 1 })).fit(REQUEST))

    expect(error).toBeInstanceOf(AiBudgetExceededError)
    expect(calls).toHaveLength(0)
  })
})

describe('AnthropicVerdictFitter refusals: never a partial result', () => {
  // Each is an answer the adapter must refuse, built by breaking a good one in exactly one way.
  const broken = (change: (result: any) => void) => {
    const result = structuredClone(RESULT) as any
    change(result)
    return result
  }

  it.each([
    ['an unknown product id', broken((r) => (r.products[0].id = 'ghost-9'))],
    ['an extra entry for an unknown product id', broken((r) => r.products.push({ id: 'ghost-9', label: 'helping', reason: 'Not on the shelf.' }))],
    ['an open product left out', broken((r) => r.products.splice(2, 1))],
    ['the first open product left out', broken((r) => r.products.splice(0, 1))],
    ['no products at all', broken((r) => (r.products = []))],
    ['a label for a product the floor fixed as likely the problem', broken((r) => r.products.push({ id: 'steroid-1', label: 'helping', reason: 'It is fine.' }))],
    ['a label for a product the floor fixed as prescribed', broken((r) => r.products.push({ id: 'rx-1', label: 'blocking', reason: 'It holds the goal back.' }))],
    ['a fixed product in place of an open one', broken((r) => (r.products[0].id = 'steroid-1'))],
    ['an open product labelled twice', broken((r) => r.products.push({ id: 'moist-1', label: 'helping', reason: 'Also helps.' }))],
    ['a label outside the three (a safety label the floor alone gives)', broken((r) => (r.products[0].label = 'likely-the-problem'))],
    ['a label outside the three (keep)', broken((r) => (r.products[0].label = 'keep'))],
    ['a label with different capitals', broken((r) => (r.products[0].label = 'Helping'))],
    ['an entry with no label', broken((r) => delete r.products[0].label)],
    ['an entry with no reason', broken((r) => delete r.products[0].reason)],
    ['an entry with a reason that is not text', broken((r) => (r.products[0].reason = 7))],
    ['an entry with no id', broken((r) => delete r.products[0].id)],
    ['products that are not a list', broken((r) => (r.products = 'retinol-1 helping'))],
    ['no products field', broken((r) => delete r.products)],
    ['no clashes field', broken((r) => delete r.clashes)],
    ['a product to reduce that is a known product but not in its pair', broken((r) => (r.clashes[0].reduceId = 'moist-1'))],
    ['a product to reduce that is a fixed product', broken((r) => (r.clashes[0].reduceId = 'rx-1'))],
    ['a product to reduce that is unknown', broken((r) => (r.clashes[0].reduceId = 'ghost-9'))],
    ['no product to reduce in a pair entry', broken((r) => delete r.clashes[0].reduceId)],
    ['a pair with an unknown product id', broken((r) => (r.clashes[0].ids = ['retinol-1', 'ghost-9']))],
    ['a pair the request did not ask about', broken((r) => (r.clashes[0] = { ids: ['retinol-1', 'moist-1'], reduceId: 'moist-1' }))],
    ['the same pair answered twice', broken((r) => r.clashes.push({ ids: ['retinol-1', 'acid-1'], reduceId: 'retinol-1' }))],
  ])('throws AnthropicRequestError when the reply has %s', async (_label, answer) => {
    const { fitter } = fitterAnswering(answer)

    expect(await caught(fitter.fit(REQUEST))).toBeInstanceOf(AnthropicRequestError)
  })

  it('throws AnthropicRequestError when the reply reduces a prescribed product that is in a clash pair, because a prescribed product is always kept', async () => {
    const request: FitRequest = { ...REQUEST, clashes: [{ ids: ['rx-1', 'acid-1'], groups: ['retinoid', 'exfoliating-acid'] }] }
    const answer: FitResult = { ...RESULT, clashes: [{ ids: ['rx-1', 'acid-1'], reduceId: 'rx-1' }] }
    const { fitter } = fitterAnswering(answer)

    expect(await caught(fitter.fit(request))).toBeInstanceOf(AnthropicRequestError)
  })

  it('throws AnthropicRequestError when the request has no clash and the reply invents one', async () => {
    const invented: FitResult = { ...GUEST_RESULT, clashes: [{ ids: ['moist-1', 'moist-1'], reduceId: 'moist-1' }] }
    const { fitter } = fitterAnswering(invented)

    expect(await caught(fitter.fit(GUEST_REQUEST))).toBeInstanceOf(AnthropicRequestError)
  })

  it.each([
    ['an empty object', {}],
    ['an array', []],
    ['a bare string', 'keep the serum'],
    ['null', null],
  ])('throws AnthropicRequestError when the whole reply is %s', async (_label, value) => {
    const { fitter } = fitterAnswering(value)

    expect(await caught(fitter.fit(REQUEST))).toBeInstanceOf(AnthropicRequestError)
  })

  it('throws AnthropicRequestError when the reply text is not JSON at all', async () => {
    const { fitter } = fitterOver(() => messageResponse({ content: [textBlock('The serum is helping and the toner is blocking.')] }))

    expect(await caught(fitter.fit(REQUEST))).toBeInstanceOf(AnthropicRequestError)
  })

  it('throws AnthropicRequestError, with no result, when the answer was cut off by max_tokens, even if the cut text happens to parse', async () => {
    const { fitter } = fitterOver(() => messageResponse({ content: [textBlock(JSON.stringify(RESULT))], stop_reason: 'max_tokens' }))

    expect(await caught(fitter.fit(REQUEST))).toBeInstanceOf(AnthropicRequestError)
  })

  it('throws AnthropicRequestError when the answer was cut off in the middle of the JSON', async () => {
    const { fitter } = fitterOver(() => messageResponse({ content: [textBlock('{"products":[{"id":"retinol-1"')], stop_reason: 'max_tokens' }))

    expect(await caught(fitter.fit(REQUEST))).toBeInstanceOf(AnthropicRequestError)
  })

  it('throws AnthropicRefusalError when the model refuses', async () => {
    const { fitter } = fitterOver(() => messageResponse({ content: [textBlock('I cannot help with that.')], stop_reason: 'refusal' }))

    expect(await caught(fitter.fit(REQUEST))).toBeInstanceOf(AnthropicRefusalError)
  })

  it('throws AnthropicRefusalError, not a result, when the model refuses even though its text is a valid answer', async () => {
    const { fitter } = fitterOver(() => messageResponse({ content: [textBlock(JSON.stringify(RESULT))], stop_reason: 'refusal' }))

    expect(await caught(fitter.fit(REQUEST))).toBeInstanceOf(AnthropicRefusalError)
  })
})

describe('AnthropicVerdictFitter errors from Claude', () => {
  it.each([
    [529, 'overloaded_error'],
    [500, 'api_error'],
  ])('lets AnthropicUnavailableError through when Claude is down (%s)', async (status, type) => {
    const { fitter } = fitterOver(() => errorResponse(status, type))

    expect(await caught(fitter.fit(REQUEST))).toBeInstanceOf(AnthropicUnavailableError)
  })

  it('lets AnthropicRequestError through when Claude rejects the request (400), for instance a schema it does not accept', async () => {
    const { fitter } = fitterOver(() => errorResponse(400, 'invalid_request_error'))

    expect(await caught(fitter.fit(REQUEST))).toBeInstanceOf(AnthropicRequestError)
  })

  it.each([
    [401, 'authentication_error'],
    [403, 'permission_error'],
  ])('lets AnthropicConfigError through when our key or account is refused (%s), a setup problem and not an outage', async (status, type) => {
    const { fitter } = fitterOver(() => errorResponse(status, type))

    expect(await caught(fitter.fit(REQUEST))).toBeInstanceOf(AnthropicConfigError)
  })
})

// Weak checks, kept as guard rails: they pin that the prompt says the things its wording was reviewed for (spec #171), not that the model obeys them.
describe('the fit-verdict prompt wording', () => {
  const prompt = verdictFitterFitVerdictPrompt.text

  it('asks for one of helping, redundant or blocking, for the products the rules left open', () => {
    expect(prompt).toMatch(/helping/i)
    expect(prompt).toMatch(/redundant/i)
    expect(prompt).toMatch(/blocking/i)
    expect(prompt).toMatch(/\bopen\b/i)
  })

  it('says a fixed product is never changed or labelled by the judge', () => {
    expect(prompt).toMatch(/\bfixed\b/i)
    expect(prompt).toMatch(/(never|do not|don't|must not)[^.]{0,120}\b(change|label|relabel|override|soften|judge)/i)
  })

  it('says the reason is about the product and never about the person', () => {
    expect(prompt).toMatch(/about the product/i)
    expect(prompt).toMatch(/(never|not)[^.]{0,80}\b(person|user)\b|\b(person|user)\b[^.]{0,80}(never|not)/i)
  })

  it('says to cite only the facts given', () => {
    expect(prompt).toMatch(/only[^.]{0,100}\b(given|provided|listed)\b|\b(given|provided|listed)\b[^.]{0,100}\bonly\b/i)
  })

  it('says to give no scores', () => {
    expect(prompt).toMatch(/(no|never|not|without)[^.]{0,80}\bscores?\b/i)
  })

  it('says never to describe change as lightness', () => {
    expect(prompt).toMatch(/(never|not|don't|avoid)[^.]{0,160}\blight\w*/i)
  })

  it('says that for each clashing pair it must choose which one to reduce', () => {
    expect(prompt).toMatch(/clash/i)
    expect(prompt).toMatch(/(which|exactly one|one of)[^.]{0,120}reduce|reduce[^.]{0,120}(which|exactly one|one of)/i)
  })
})

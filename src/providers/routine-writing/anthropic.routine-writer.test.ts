import { describe, expect, it, vi } from 'vitest'
import type { Routine, RoutineSkeleton } from '../../modules/routines/routines.types'
import { routineWriterWriteRoutinePrompt } from '../../prompts/prompts.generated'
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
import { AnthropicRoutineWriter } from './anthropic.routine-writer'

const ROUTED_TO = 'claude-haiku-5-5'
const LEAD_IN = 'Write the routine for this skeleton:'
// Written out, not read from the adapter: Sonnet's adaptive thinking counts against max_tokens, and a routine with its reasons runs to a few thousand tokens.
const EXPECTED_MAX_TOKENS = 8192

/** One small skeleton: a kept cleanser, a serum to cut back, a retinoid to stop, and a moisturise gap with a candidate. */
const SKELETON: RoutineSkeleton = {
  goal: 'even-tone',
  person: { seen: [{ concern: 'hd_age_spot', level: 'some' }], alsoNoticed: [], skinType: 'combination', lowConfidence: [], cautions: [], budgetBand: null },
  steps: ['cleanse', 'treat', 'moisturise'],
  shelf: [
    { id: 'cleanser-1', brand: 'Brand', name: 'Gentle cleanser', ingredients: ['Aqua', 'Glycerin'], step: 'cleanse', verdict: { kind: 'keep' }, sourceUrls: [] },
    { id: 'serum-1', brand: null, name: 'Bright serum', ingredients: ['Aqua', 'Niacinamide'], step: 'treat', verdict: { kind: 'reduce', maxFrequency: 'alternate-days' }, sourceUrls: ['https://rules.example/serum-1'] },
    { id: 'retinol-1', brand: 'Brand', name: 'Retinol night', ingredients: ['Retinol'], step: 'treat', verdict: { kind: 'stop', taperTemplateId: 'tpl-retinoid' }, sourceUrls: [] },
  ],
  gaps: [
    {
      step: 'moisturise',
      candidates: [
        {
          code: 'mo-1',
          brand: 'Brand',
          name: 'Light moisturiser',
          form: 'cream',
          ingredients: ['Aqua', 'Glycerin'],
          skinConcerns: ['hd_moisture'],
          frequency: 'am-pm',
          priceMin: 5,
          priceMax: 10,
          evidenceUrls: ['https://evidence.example/mo-1'],
          ingredientsSourceUrl: 'https://ingredients.example/mo-1',
          outcomeHint: null,
        },
      ],
    },
  ],
  limits: {
    allowed: { cleanse: ['am', 'pm', 'am-pm'], treat: ['pm', 'alternate-days', 'weekly', 'as-needed'], moisturise: ['am', 'pm', 'am-pm'], protect: ['am'] },
    maxNewProducts: 1,
  },
  hintsShown: false,
}

/** The routine the model is meant to write for SKELETON, and what the adapter must hand back. */
const ROUTINE: Routine = {
  steps: [
    { step: 'cleanse', product: { kind: 'shelf', id: 'cleanser-1' }, frequency: 'am-pm', reason: 'A mild cleanser that keeps skin comfortable.', grounding: [] },
    { step: 'treat', product: { kind: 'shelf', id: 'serum-1' }, frequency: 'alternate-days', reason: 'Niacinamide helps with evenness; every other day is gentler.', grounding: ['https://rules.example/serum-1'] },
    { step: 'moisturise', product: { kind: 'candidate', code: 'mo-1' }, frequency: 'am-pm', reason: 'Glycerin (a water-holding ingredient) keeps skin soft.', grounding: ['https://ingredients.example/mo-1'] },
  ],
  tapers: [{ shelfProductId: 'retinol-1', templateId: 'tpl-retinoid' }],
  expectation: 'Most people see a change in 8 to 12 weeks.',
}

/** Every job on MODEL, except `routed`, which goes to ROUTED_TO: whichever job the adapter uses shows in the model it sends. */
const writerWith = (fetch: typeof globalThis.fetch, ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS }), routed?: AiJob) =>
  new AnthropicRoutineWriter(
    new AnthropicClient({
      apiKey: API_KEY,
      models: { ...MODELS, ...(routed ? { [routed]: ROUTED_TO } : {}) },
      ledger,
      baseURL: 'https://anthropic.example',
      fetch,
    }),
  )

/** A fetch whose model answers `routine`; `calls` records the requests. */
const answeringFetch = (routine: unknown) => stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(routine))] }))

/** A writer whose model answers `routine` (any value, so a test can break it). */
const writerAnswering = (routine: unknown = ROUTINE) => {
  const stub = answeringFetch(routine)
  return { ...stub, writer: writerWith(stub.fetch) }
}

/** A writer over a client whose HTTP goes through `fetch`; the returned `calls` records the requests. */
const writerOver = (...responders: Parameters<typeof stubFetch>) => {
  const { calls, fetch } = stubFetch(...responders)
  return { calls, writer: writerWith(fetch) }
}

const userText = (body: any): string => {
  expect(body.messages).toHaveLength(1)
  expect(body.messages[0].role).toBe('user')
  const raw: string | Block[] = body.messages[0].content
  const content: Block[] = typeof raw === 'string' ? [{ type: 'text', text: raw }] : raw
  expect(content.every((block) => block.type === 'text')).toBe(true)
  return content.map((block) => block.text).join('')
}

describe('the write-routine AI job', () => {
  it('is one of the jobs the AI spend ledger and the client know', () => {
    expect(AI_JOBS).toContain('write-routine')
  })

  it('is the job the routine writer prompt runs under', () => {
    expect(routineWriterWriteRoutinePrompt.job).toBe('write-routine')
  })
})

describe('AnthropicRoutineWriter request', () => {
  it('sends the routine writer prompt as the system prompt, with no forced tool choice', async () => {
    const { calls, writer } = writerAnswering()

    await writer.write(SKELETON)

    expect(JSON.stringify(calls[0]!.body.system)).toContain(JSON.stringify(routineWriterWriteRoutinePrompt.text).slice(1, -1))
    expect('tool_choice' in calls[0]!.body).toBe(false)
  })

  it('sends one user message: the lead-in, then the skeleton as JSON', async () => {
    const { calls, writer } = writerAnswering()

    await writer.write(SKELETON)

    const text = userText(calls[0]!.body)
    expect(text.startsWith(LEAD_IN)).toBe(true)
    const json = text.slice(LEAD_IN.length)
    expect(JSON.parse(json)).toEqual(SKELETON)
  })

  it('keeps the skeleton out of the system prompt, so the instructions do not carry it', async () => {
    const { calls, writer } = writerAnswering()

    await writer.write({ ...SKELETON, shelf: [{ ...SKELETON.shelf[0]!, name: 'zzqx-unique-product-name' }] })

    expect(JSON.stringify(calls[0]!.body.system)).not.toContain('zzqx-unique-product-name')
    expect(requestText(calls[0]!.body)).toContain('zzqx-unique-product-name')
  })

  it('leaves room for the answer: max_tokens is 8192, because adaptive thinking counts against it', async () => {
    const { calls, writer } = writerAnswering()

    await writer.write(SKELETON)

    expect(calls[0]!.body.max_tokens).toBe(EXPECTED_MAX_TOKENS)
  })

  it('asks for a json_schema structured output', async () => {
    const { calls, writer } = writerAnswering()

    await writer.write(SKELETON)

    const format = calls[0]!.body.output_config.format
    expect(format.type).toBe('json_schema')
    expect(format.schema).toEqual(expect.objectContaining({ type: 'object' }))
  })

  it('writes the product choice as anyOf, which structured outputs document, and never as oneOf, which they do not', async () => {
    const { calls, writer } = writerAnswering()

    await writer.write(SKELETON)

    const sent = JSON.stringify(calls[0]!.body.output_config.format.schema)
    expect(sent).not.toContain('"oneOf"')
    expect(sent).toContain('"anyOf"')
  })

  it('does not ask the model to send fields the Routine contract does not have', async () => {
    const { calls, writer } = writerAnswering()

    await writer.write(SKELETON)

    const top = calls[0]!.body.output_config.format.schema
    expect(Object.keys(top.properties).sort()).toEqual(['expectation', 'steps', 'tapers'])
    expect([...top.required].sort()).toEqual(['expectation', 'steps', 'tapers'])
    expect(top.additionalProperties).toBe(false)
  })
})

describe('AnthropicRoutineWriter answers', () => {
  it('returns the routine the model wrote, as the Routine contract has it', async () => {
    const { writer } = writerAnswering(ROUTINE)

    await expect(writer.write(SKELETON)).resolves.toStrictEqual(ROUTINE)
  })

  it('returns every kind of product the model can choose (shelf, candidate, none) as the contract has it', async () => {
    const withNone: Routine = {
      ...ROUTINE,
      steps: [...ROUTINE.steps, { step: 'protect', product: { kind: 'none' }, frequency: 'am', reason: 'Use the sun protection you already have.', grounding: [] }],
    }

    await expect(writerAnswering(withNone).writer.write(SKELETON)).resolves.toStrictEqual(withNone)
  })

  it('returns a routine with no tapers and no steps as it is, leaving it to the gates to judge', async () => {
    const empty: Routine = { steps: [], tapers: [], expectation: 'Most people see a change in 8 to 12 weeks.' }

    await expect(writerAnswering(empty).writer.write(SKELETON)).resolves.toStrictEqual(empty)
  })
})

describe('AnthropicRoutineWriter job routing and cost', () => {
  it('asks Claude as the write-routine job and uses the model configured for it', async () => {
    const { calls, fetch } = answeringFetch(ROUTINE)

    await writerWith(fetch, undefined, 'write-routine').write(SKELETON)

    expect(calls[0]!.body.model).toBe(ROUTED_TO)
  })

  it('does not use the model of any other job', async () => {
    const { calls, fetch } = answeringFetch(ROUTINE)
    const others = AI_JOBS.filter((job) => job !== 'write-routine')

    for (const other of others) await writerWith(fetch, undefined, other).write(SKELETON)

    expect(calls.map((c) => c.body.model)).toEqual(others.map(() => MODEL))
  })

  it('records its call on the ledger under the write-routine job', async () => {
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })
    const stub = answeringFetch(ROUTINE)

    await writerWith(stub.fetch, ledger).write(SKELETON)

    expect(ledger.entries.map((e) => [e.job, e.model, e.status])).toEqual([['write-routine', MODEL, 'settled']])
  })

  it('makes exactly one request per routine', async () => {
    const { calls, writer } = writerAnswering()

    await writer.write(SKELETON)

    expect(calls).toHaveLength(1)
  })

  it('throws AiBudgetExceededError, sending nothing, when the spend cap would be passed', async () => {
    const { calls, fetch } = answeringFetch(ROUTINE)

    const error = await caught(writerWith(fetch, new MemoryAiSpendLedger({ capMicros: 1 })).write(SKELETON))

    expect(error).toBeInstanceOf(AiBudgetExceededError)
    expect(calls).toHaveLength(0)
  })
})

describe('AnthropicRoutineWriter errors: never a partial routine', () => {
  // Each is a routine the contract rejects, built by breaking a good one in exactly one way.
  const broken = (change: (routine: any) => void) => {
    const routine = structuredClone(ROUTINE) as any
    change(routine)
    return routine
  }

  it.each([
    ['no expectation', broken((r) => delete r.expectation)],
    ['no tapers', broken((r) => delete r.tapers)],
    ['no steps', broken((r) => delete r.steps)],
    ['steps that are not a list', broken((r) => (r.steps = 'cleanse then treat'))],
    ['an entry with a frequency outside the list', broken((r) => (r.steps[0].frequency = 'hourly'))],
    ['an entry with a step outside the four', broken((r) => (r.steps[0].step = 'exfoliate'))],
    ['an entry with a product kind outside the three', broken((r) => (r.steps[0].product = { kind: 'bogus' }))],
    ['an entry with no reason', broken((r) => delete r.steps[0].reason)],
    ['an entry with grounding that is not a list of links', broken((r) => (r.steps[0].grounding = 'https://rules.example/serum-1'))],
    ['a taper with no template', broken((r) => delete r.tapers[0].templateId)],
  ])('lets AnthropicRequestError through when the reply has %s', async (_label, routine) => {
    const { writer } = writerAnswering(routine)

    expect(await caught(writer.write(SKELETON))).toBeInstanceOf(AnthropicRequestError)
  })

  it.each([
    ['an empty object', {}],
    ['an array', []],
    ['a bare string', 'use the cleanser'],
    ['null', null],
  ])('lets AnthropicRequestError through when the whole reply is %s', async (_label, value) => {
    const { writer } = writerAnswering(value)

    expect(await caught(writer.write(SKELETON))).toBeInstanceOf(AnthropicRequestError)
  })

  it('lets AnthropicRequestError through when the reply text is not JSON at all', async () => {
    const { writer } = writerOver(() => messageResponse({ content: [textBlock('Here is your routine: cleanse, treat...')] }))

    expect(await caught(writer.write(SKELETON))).toBeInstanceOf(AnthropicRequestError)
  })

  it('lets AnthropicRequestError through, with no routine, when the answer was cut off by max_tokens, even if the cut text happens to parse', async () => {
    const { writer } = writerOver(() => messageResponse({ content: [textBlock(JSON.stringify(ROUTINE))], stop_reason: 'max_tokens' }))

    expect(await caught(writer.write(SKELETON))).toBeInstanceOf(AnthropicRequestError)
  })

  it('lets AnthropicRequestError through when the answer was cut off in the middle of the JSON', async () => {
    const { writer } = writerOver(() => messageResponse({ content: [textBlock('{"steps":[{"step":"cleanse"')], stop_reason: 'max_tokens' }))

    expect(await caught(writer.write(SKELETON))).toBeInstanceOf(AnthropicRequestError)
  })

  it('throws AnthropicRefusalError when the model refuses', async () => {
    const { writer } = writerOver(() => messageResponse({ content: [textBlock('I cannot help with that.')], stop_reason: 'refusal' }))

    expect(await caught(writer.write(SKELETON))).toBeInstanceOf(AnthropicRefusalError)
  })

  it('lets AnthropicUnavailableError through when Claude is overloaded (529)', async () => {
    const { writer } = writerOver(() => errorResponse(529, 'overloaded_error'))

    expect(await caught(writer.write(SKELETON))).toBeInstanceOf(AnthropicUnavailableError)
  })

  it('lets AnthropicUnavailableError through when Claude fails (500)', async () => {
    const { writer } = writerOver(() => errorResponse(500, 'api_error'))

    expect(await caught(writer.write(SKELETON))).toBeInstanceOf(AnthropicUnavailableError)
  })

  it('lets AnthropicRequestError through when Claude rejects the request (400), for instance a schema it does not accept', async () => {
    const { writer } = writerOver(() => errorResponse(400, 'invalid_request_error'))

    expect(await caught(writer.write(SKELETON))).toBeInstanceOf(AnthropicRequestError)
  })

  it.each([
    [401, 'authentication_error'],
    [403, 'permission_error'],
  ])('lets AnthropicConfigError through when our key or account is refused (%s), a setup problem and not an outage', async (status, type) => {
    const { writer } = writerOver(() => errorResponse(status, type))

    expect(await caught(writer.write(SKELETON))).toBeInstanceOf(AnthropicConfigError)
  })
})

describe('AnthropicRoutineWriter privacy', () => {
  it('writes nothing to the console, neither the skeleton nor the model text, whether the call works or fails', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    try {
      await writerAnswering().writer.write(SKELETON)
      await caught(writerOver(() => messageResponse({ content: [textBlock('not json, but it mentions Bright serum')] })).writer.write(SKELETON))
      await caught(writerOver(() => errorResponse(500, 'api_error')).writer.write(SKELETON))

      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

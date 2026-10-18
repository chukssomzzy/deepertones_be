import { describe, expect, it } from 'vitest'
import { goalReaderReadGoalPrompt } from '../../prompts/prompts.generated'
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
import { AnthropicGoalReader } from './anthropic.goal-reader'

const ROUTED_TO = 'claude-haiku-5-5'
const TYPED = 'make my face clear'
const NO_GOAL = { goal: null, wantsLighter: false }
// Written out, not read from GOALS: the five goals the app offers, in the order of the chips.
const FIVE_GOALS = ['clear-skin', 'even-tone', 'fade-dark-marks', 'brighter', 'glow']

/** The structured answer the model gives; a test overrides only what it is about. */
const reply = (overrides: Record<string, unknown> = {}) => ({ goal: 'clear-skin', wantsLighter: false, ...overrides })

/** Every job on MODEL (read-goal included), except `routed`, which goes to ROUTED_TO: whichever job the adapter uses shows in the model it sends. */
const readerWith = (fetch: typeof globalThis.fetch, ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS }), routed?: AiJob) =>
  new AnthropicGoalReader(
    new AnthropicClient({
      apiKey: API_KEY,
      models: { ...MODELS, 'read-goal': MODEL, ...(routed ? { [routed]: ROUTED_TO } : {}) },
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

const structured = (value: unknown) => () => messageResponse({ content: [textBlock(JSON.stringify(value))] })
const answering = (value: unknown) => readerOver(structured(value)).reader

/** Every schema object must forbid extra properties, and none may use keywords the API rejects. `default` is one: a parse-time leniency (zod's catch) must not reach the schema. */
const UNSUPPORTED_KEYWORDS = ['default', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'maxItems']
const assertApiSafe = (schema: unknown, path = 'schema') => {
  if (Array.isArray(schema)) return schema.forEach((s, i) => assertApiSafe(s, `${path}[${i}]`))
  if (!schema || typeof schema !== 'object') return
  const node = schema as Record<string, unknown>
  if (node.type === 'object') expect(node.additionalProperties, `${path}.additionalProperties`).toBe(false)
  for (const keyword of UNSUPPORTED_KEYWORDS) expect(node, `${path} uses ${keyword}`).not.toHaveProperty(keyword)
  for (const [key, child] of Object.entries(node)) assertApiSafe(child, `${path}.${key}`)
}

describe('the read-goal AI job', () => {
  it('is one of the jobs the AI spend ledger and the client know', () => {
    expect(AI_JOBS).toContain('read-goal')
  })

  it('is the job the goal reader prompt runs under', () => {
    expect(goalReaderReadGoalPrompt.job).toBe('read-goal')
  })
})

describe('AnthropicGoalReader request', () => {
  it('sends the typed text, and nothing else, as the user message', async () => {
    const { calls, reader } = readerOver(structured(reply()))
    const typed = 'I want to be fairer, no spots < 1cm'

    await reader.read(typed)

    const body = calls[0]!.body
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
    // The content may be one string or a list of blocks; either way it is the typed text and no lead-in or framing.
    const raw: string | Block[] = body.messages[0].content
    const content: Block[] = typeof raw === 'string' ? [{ type: 'text', text: raw }] : raw
    expect(content.every((block) => block.type === 'text')).toBe(true)
    expect(content.map((block) => block.text).join('')).toBe(typed)
  })

  it('keeps the typed text out of the system prompt, so the instructions do not carry it', async () => {
    const { calls, reader } = readerOver(structured(reply()))

    await reader.read('zzqx-unique-typed-text')

    expect(JSON.stringify(calls[0]!.body.system)).not.toContain('zzqx-unique-typed-text')
  })

  it('sends the read-goal prompt as the system prompt, with no forced tool choice', async () => {
    const { calls, reader } = readerOver(structured(reply()))

    await reader.read(TYPED)

    expect(JSON.stringify(calls[0]!.body.system)).toContain(JSON.stringify(goalReaderReadGoalPrompt.text).slice(1, -1))
    expect('tool_choice' in calls[0]!.body).toBe(false)
  })

  it('asks for one closed json_schema object with a required goal (the five goals or "none") and a required boolean wantsLighter', async () => {
    const { calls, reader } = readerOver(structured(reply()))

    await reader.read(TYPED)

    const format = calls[0]!.body.output_config.format
    expect(format.type).toBe('json_schema')
    const schema = format.schema
    expect(schema.type).toBe('object')
    assertApiSafe(schema)
    expect(Object.keys(schema.properties).sort()).toEqual(['goal', 'wantsLighter'])
    expect([...schema.required].sort()).toEqual(['goal', 'wantsLighter'])
    expect([...schema.properties.goal.enum].sort()).toEqual([...FIVE_GOALS, 'none'].sort())
    expect(schema.properties.wantsLighter.type).toBe('boolean')
  })

  it('tells the model the typed text is user-supplied data whose instructions must be ignored, and what to answer when it is not about skin', async () => {
    const { calls, reader } = readerOver(structured(reply()))

    await reader.read(TYPED)

    const prompt = requestText(calls[0]!.body)
    expect(prompt).toMatch(/user-supplied/i)
    expect(prompt).toMatch(/ignore/i)
    expect(prompt).toMatch(/instructions/i)
    expect(prompt).toContain('none')
    expect(prompt).toContain('wantsLighter')
  })
})

// Weak checks, kept as guard rails: they pin that the prompt says the things its wording was reviewed for, not that the model obeys them.
describe('the read-goal prompt wording', () => {
  const prompt = goalReaderReadGoalPrompt.text

  it('names "toning", which is what lightening is called locally', () => {
    expect(prompt).toMatch(/toning/i)
  })

  it('says that mentioning a lightening or bleaching product someone used, or has stopped, is not wanting to be lighter', () => {
    expect(prompt).toMatch(/stop(ped)?/i)
    expect(prompt).toMatch(/used/i)
  })

  it('says that lightening spots or marks is not wanting to be lighter', () => {
    // "lighten", not "fade": the goal's own name, fade-dark-marks, would satisfy a check for fading marks.
    expect(prompt).toMatch(/lighten[^.]{0,80}(spots?|marks?)|(spots?|marks?)[^.]{0,80}lighten/i)
  })

  it('does not tell the model to pick the goal that "fits best", which pushes it to guess a goal for words that fit none', () => {
    expect(prompt).not.toContain('fits best')
  })
})

describe('AnthropicGoalReader job routing and cost', () => {
  it('asks Claude as the read-goal job and uses the model configured for it', async () => {
    const { calls, fetch } = stubFetch(structured(reply()))

    await readerWith(fetch, undefined, 'read-goal').read(TYPED)

    expect(calls[0]!.body.model).toBe(ROUTED_TO)
  })

  it('does not use the model of any other job', async () => {
    const { calls, fetch } = stubFetch(structured(reply()))
    const others = AI_JOBS.filter((job) => job !== 'read-goal')

    for (const other of others) await readerWith(fetch, undefined, other).read(TYPED)

    expect(calls.map((c) => c.body.model)).toEqual(others.map(() => MODEL))
  })

  it('records its call on the ledger under the read-goal job', async () => {
    const { fetch } = stubFetch(structured(reply()))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await readerWith(fetch, ledger).read(TYPED)

    expect(ledger.entries.map((e) => [e.job, e.model, e.status])).toEqual([['read-goal', MODEL, 'settled']])
  })

  it('makes exactly one request per read', async () => {
    const { calls, reader } = readerOver(structured(reply()))

    await reader.read(TYPED)

    expect(calls).toHaveLength(1)
  })

  it('throws AiBudgetExceededError, sending nothing, when the spend cap would be passed', async () => {
    const { calls, fetch } = stubFetch(structured(reply()))

    const error = await caught(readerWith(fetch, new MemoryAiSpendLedger({ capMicros: 1 })).read(TYPED))

    expect(error).toBeInstanceOf(AiBudgetExceededError)
    expect(calls).toHaveLength(0)
  })
})

describe('AnthropicGoalReader answers', () => {
  it.each(FIVE_GOALS)('returns the goal %s as it is when the user did not ask to be lighter', async (goal) => {
    await expect(answering(reply({ goal })).read(TYPED)).resolves.toStrictEqual({ goal, wantsLighter: false })
  })

  it('returns no goal, and no wish to be lighter, when the model says the text is not about skin ("none")', async () => {
    await expect(answering(reply({ goal: 'none', wantsLighter: false })).read('what is the capital of France')).resolves.toStrictEqual(NO_GOAL)
  })

  it.each([...FIVE_GOALS, 'none'])('always returns brighter, with wantsLighter, when the model says the user wants to be lighter, whatever goal it gave (%s)', async (goal) => {
    await expect(answering(reply({ goal, wantsLighter: true })).read('I want to be fairer')).resolves.toStrictEqual({ goal: 'brighter', wantsLighter: true })
  })

  it.each([
    ['a goal outside the five', { goal: 'darker' }],
    ['a goal in other letters than the list\'s', { goal: 'Clear-Skin' }],
    ['a goal with spaces in place of the hyphen', { goal: 'clear skin' }],
    ['an empty goal', { goal: '' }],
    ['a goal that is not a string', { goal: 7 }],
    ['a null goal', { goal: null }],
    ['no goal', { goal: undefined }],
    ['no wantsLighter', { wantsLighter: undefined }],
    ['a wantsLighter that is not a boolean', { wantsLighter: 'yes' }],
  ])('treats a reply with %s as no goal, and no wish to be lighter, rather than a failed call', async (_label, overrides) => {
    await expect(answering(reply(overrides)).read(TYPED)).resolves.toStrictEqual(NO_GOAL)
  })

  it.each([
    ['an empty object', {}],
    ['an array', []],
    ['a bare string', 'glow'],
    ['a number', 3],
  ])('treats %s as the whole reply as no goal, and no wish to be lighter', async (_label, value) => {
    await expect(answering(value).read(TYPED)).resolves.toStrictEqual(NO_GOAL)
  })
})

describe('AnthropicGoalReader errors', () => {
  it('throws AnthropicRefusalError when the model refuses', async () => {
    const { reader } = readerOver(() => messageResponse({ content: [textBlock('I cannot help with that.')], stop_reason: 'refusal' }))

    expect(await caught(reader.read(TYPED))).toBeInstanceOf(AnthropicRefusalError)
  })

  it('lets AnthropicUnavailableError through when Claude is overloaded (529)', async () => {
    const { reader } = readerOver(() => errorResponse(529, 'overloaded_error'))

    expect(await caught(reader.read(TYPED))).toBeInstanceOf(AnthropicUnavailableError)
  })

  it('lets AnthropicUnavailableError through when Claude fails (500)', async () => {
    const { reader } = readerOver(() => errorResponse(500, 'api_error'))

    expect(await caught(reader.read(TYPED))).toBeInstanceOf(AnthropicUnavailableError)
  })

  it('lets AnthropicRequestError through when Claude rejects the request (400)', async () => {
    const { reader } = readerOver(() => errorResponse(400, 'invalid_request_error'))

    expect(await caught(reader.read(TYPED))).toBeInstanceOf(AnthropicRequestError)
  })

  it.each([
    [401, 'authentication_error'],
    [403, 'permission_error'],
  ])('lets AnthropicConfigError through when our key or account is refused (%s), a setup problem and not an outage', async (status, type) => {
    const { reader } = readerOver(() => errorResponse(status, type))

    expect(await caught(reader.read(TYPED))).toBeInstanceOf(AnthropicConfigError)
  })

  it('lets AnthropicRequestError through when the answer was cut off by max_tokens, as the client defines it', async () => {
    const { reader } = readerOver(() => messageResponse({ content: [textBlock('{"goal":')], stop_reason: 'max_tokens' }))

    expect(await caught(reader.read(TYPED))).toBeInstanceOf(AnthropicRequestError)
  })

  it('lets AnthropicRequestError through when the reply text is not JSON at all', async () => {
    const { reader } = readerOver(() => messageResponse({ content: [textBlock('this is not JSON')] }))

    expect(await caught(reader.read(TYPED))).toBeInstanceOf(AnthropicRequestError)
  })
})

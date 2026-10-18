import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PermanentJobError } from '../../jobs/job'
import { type Actor, runAs } from '../../lib/context'
import { AiBudgetExceededError } from '../../providers/anthropic/ai-spend.provider'
import { AnthropicRefusalError, AnthropicRequestError, AnthropicUnavailableError } from '../../providers/anthropic/anthropic.provider'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import type { Mention } from '../../providers/mention-reading/mention-reader.provider'
import { MemoryMentionReader } from '../../providers/mention-reading/memory.mention-reader'
import type { ProductIdentity } from '../../providers/product-research/product-researcher.provider'
import { CatalogBusyError, ResearchInProgressError, type ResearchResult, type ResolveResult } from '../catalog/catalog.service'
import { FakeSafetyRepository } from './safety.repository.fake'
import { SafetyService } from './safety.service'

// The parse of the reaction and prescription words: the queueing in `set`, the repair in `current`, `parse` itself (run by the queue as a
// system actor), `markParseFailed` (the dead-letter hook) and `currentMentions`. The saving and reading of answers is safety.service.test.ts.
// The reader is MemoryMentionReader, the queue MemoryJobQueue and the catalog a scripted stand-in, so each test says what the model and the
// catalog answer and reads the outcome from the stored rows and the queue.

// The one clock every test hangs off; later times are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

const actor = (userId: string, profileId: string, status: 'anonymous' | 'verified' = 'anonymous'): Actor => ({ kind: 'user', userId, status, profileId })

// Amara and Tolu are two accounts; Amara has a second profile.
const AMARA = actor('user-amara', 'profile-amara-1')
const AMARA_SECOND_PROFILE = actor('user-amara', 'profile-amara-2')
const TOLU = actor('user-tolu', 'profile-tolu-1', 'verified')
const PUBLIC: Actor = { kind: 'public' }
const SYSTEM: Actor = { kind: 'system', job: 'parse-safety' }

const REACTION = 'Caro White and fragrance'
const PRESCRIPTION = 'Dermovate from my dermatologist'

// A product mention whose brand is its name, as for "Caro White" or "Dermovate"; `over` changes what a test is about.
const product = (name: string, over: Partial<Extract<Mention, { kind: 'product' }>> = {}): Mention => ({ kind: 'product', brand: name, name, category: 'skin', ...over })
const ingredient = (name: string): Mention => ({ kind: 'ingredient', name })

/** A catalog that answers from functions a test sets, and records what it was asked. A `Pick` of the real service. */
class ScriptedCatalog {
  readonly resolved: ProductIdentity[] = []
  readonly researched: string[] = []
  // By default every product is in the catalog and ready, with an id made from its name.
  onResolve: (identity: ProductIdentity) => ResolveResult | Promise<ResolveResult> = (identity) => ({
    kind: 'ready',
    productId: `product-${identity.name}`,
    formulationId: `formulation-${identity.name}`,
  })
  onResearch: (productId: string) => ResearchResult | Promise<ResearchResult> = (productId) => ({ kind: 'found', formulationId: `formulation-${productId}` })

  async resolve(identity: ProductIdentity): Promise<ResolveResult> {
    this.resolved.push(identity)
    return this.onResolve(identity)
  }

  async research(productId: string): Promise<ResearchResult> {
    this.researched.push(productId)
    return this.onResearch(productId)
  }
}

let clock: Date
let repository: FakeSafetyRepository
let reader: MemoryMentionReader
let catalog: ScriptedCatalog
let jobs: MemoryJobQueue
let service: SafetyService

type SetInput = Parameters<SafetyService['set']>[0]
const set = (who: Actor, input: SetInput) => runAs(who, () => service.set(input))
const current = (who: Actor) => runAs(who, () => service.current())
const currentMentions = (who: Actor) => runAs(who, () => service.currentMentions())
const parse = (safetyId: string) => runAs(SYSTEM, () => service.parse(safetyId))
const markParseFailed = (safetyId: string) => runAs(SYSTEM, () => service.markParseFailed(safetyId))
const setClock = (offsetMs: number) => {
  clock = at(offsetMs)
}

/** Saves an answer and answers the id of the row it became, the id the queue message carries. */
const answer = async (who: Actor, input: SetInput) => {
  await set(who, input)
  if (who.kind !== 'user') throw new Error('an answer needs a user')
  return (await repository.current(who.profileId))!.id
}
const reactionAnswer = (text = REACTION) => answer(AMARA, { choices: ['reaction'], reactionText: text })
const bothAnswer = () => answer(AMARA, { choices: ['reaction', 'prescription'], reactionText: REACTION, prescriptionText: PRESCRIPTION })

/** Makes the reader answer by the words it is given. A text it was not told about has no mentions. */
const readerSays = (byText: Record<string, Mention[]>) => reader.respondWith((text) => byText[text] ?? [])

const rowOf = async (safetyId: string) => (await repository.find(safetyId))!
const mentionsOf = (safetyId: string) => repository.mentions(safetyId)
const shape = async (safetyId: string) => (await mentionsOf(safetyId)).map((m) => [m.name, m.resolution, m.productId] as const)
const queued = () => jobs.enqueued.map((e) => ({ job: e.job, body: e.body, delaySeconds: e.delaySeconds ?? 0 }))

const spyOnConsole = () => (['log', 'debug', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
const loggedBy = (spies: ReturnType<typeof spyOnConsole>) => spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call)))

beforeEach(() => {
  clock = T0
  repository = new FakeSafetyRepository()
  reader = new MemoryMentionReader()
  catalog = new ScriptedCatalog()
  jobs = new MemoryJobQueue()
  let n = 0
  service = new SafetyService({ repository, reader, catalog, jobs, now: () => clock, newId: () => `id-${++n}` })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SafetyService.set and the parse it queues', () => {
  it('has nothing to parse, and queues nothing, when no reaction or prescription words were typed', async () => {
    await set(AMARA, { choices: ['pregnant', 'reaction', 'prescription'] })

    expect(await repository.current('profile-amara-1')).toMatchObject({ parseState: 'none', parseDueAt: null })
    expect(jobs.enqueued).toEqual([])
  })

  it('treats words that are empty once trimmed as no words: nothing to parse, nothing queued', async () => {
    await set(AMARA, { choices: ['reaction', 'prescription'], reactionText: '   ', prescriptionText: '\n' })

    expect(await repository.current('profile-amara-1')).toMatchObject({ parseState: 'none', parseDueAt: null })
    expect(jobs.enqueued).toEqual([])
  })

  it('has nothing to parse when "none of these" is the answer', async () => {
    await set(AMARA, { choices: ['none'] })

    expect(await repository.current('profile-amara-1')).toMatchObject({ parseState: 'none' })
    expect(jobs.enqueued).toEqual([])
  })

  it('marks reaction words pending, due now, and queues one parse-safety message carrying only the id of the row, with no delay', async () => {
    const safetyId = await reactionAnswer()

    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'pending', parseDueAt: T0 })
    expect(queued()).toEqual([{ job: 'parse-safety', body: { safetyId }, delaySeconds: 0 }])
  })

  it('queues a parse for prescription words alone', async () => {
    const safetyId = await answer(AMARA, { choices: ['prescription'], prescriptionText: PRESCRIPTION })

    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'pending', parseDueAt: T0 })
    expect(queued()).toEqual([{ job: 'parse-safety', body: { safetyId }, delaySeconds: 0 }])
  })

  it('queues one parse, not two, for an answer with both words', async () => {
    const safetyId = await bothAnswer()

    expect(queued()).toEqual([{ job: 'parse-safety', body: { safetyId }, delaySeconds: 0 }])
  })

  it('does not queue anything for an answer it refuses, and stores nothing', async () => {
    await errorOf(set(AMARA, { choices: ['pregnant'], reactionText: REACTION }))
    await errorOf(set(AMARA, { choices: ['reaction'], reactionText: 'https://evil.example' }))

    expect(jobs.enqueued).toEqual([])
    expect(await repository.history('profile-amara-1')).toEqual([])
  })

  it('still answers the same view as before: the parse adds nothing the app can see', async () => {
    const view = await set(AMARA, { choices: ['reaction'], reactionText: REACTION })

    expect(Object.keys(view).sort()).toEqual(['choices', 'excludesPregnancyCaution', 'prescriptionText', 'reactionText', 'updatedAt'])
  })

  // At most one parse per profile per hour: the message waits until an hour after the last answer that had words.
  describe('the delay', () => {
    it.each([
      ['in the same instant', 0, 3600],
      ['10 minutes later', 10 * MINUTE, 3000],
      ['59 minutes 59 seconds later (one second short of the hour)', HOUR - SECOND, 1],
      ['exactly an hour later (the boundary)', HOUR, 0],
      ['an hour and a second later', HOUR + SECOND, 0],
      ['a day later', 24 * HOUR, 0],
    ])('queues the next parse for words saved %s with a delay of %s seconds', async (_label, laterMs, expectedDelay) => {
      await reactionAnswer()
      jobs.enqueued.length = 0
      setClock(laterMs)

      const safetyId = await reactionAnswer('Movate cream')

      expect(queued()).toEqual([{ job: 'parse-safety', body: { safetyId }, delaySeconds: expectedDelay }])
      expect((await rowOf(safetyId)).parseDueAt).toEqual(new Date(clock.getTime() + expectedDelay * SECOND))
    })

    it('does not delay the first parse of a profile', async () => {
      await reactionAnswer()

      expect(queued()[0]!.delaySeconds).toBe(0)
    })

    it('does not count an earlier answer that had no words', async () => {
      await set(AMARA, { choices: ['pregnant', 'reaction'] })
      setClock(10 * MINUTE)

      await reactionAnswer()

      expect(queued()).toEqual([{ job: 'parse-safety', body: { safetyId: expect.any(String) }, delaySeconds: 0 }])
    })

    it('counts from the newest answer that had words, though one without words came between', async () => {
      await reactionAnswer()
      setClock(10 * MINUTE)
      await set(AMARA, { choices: ['none'] })
      setClock(20 * MINUTE)
      jobs.enqueued.length = 0

      await reactionAnswer('Movate cream')

      expect(queued().map((q) => q.delaySeconds)).toEqual([2400])
    })

    it('counts an hour from the time the last answer was saved, not from when its parse is due: each answer with words pushes the next one on', async () => {
      await reactionAnswer()
      setClock(10 * MINUTE)
      await reactionAnswer('Movate cream')
      setClock(20 * MINUTE)
      jobs.enqueued.length = 0

      await reactionAnswer('Betnovate')

      // Saved 10 minutes ago, not 20: the 3000 seconds that remain of the hour, not the 2400 after the first answer.
      expect(queued().map((q) => q.delaySeconds)).toEqual([3000])
    })

    it('counts prescription words as words', async () => {
      await answer(AMARA, { choices: ['prescription'], prescriptionText: PRESCRIPTION })
      setClock(30 * MINUTE)
      jobs.enqueued.length = 0

      await reactionAnswer()

      expect(queued().map((q) => q.delaySeconds)).toEqual([1800])
    })

    it('keeps each profile\'s hour to itself: another account, or another profile of the account, is not held back', async () => {
      await reactionAnswer()
      setClock(MINUTE)
      jobs.enqueued.length = 0

      await answer(TOLU, { choices: ['reaction'], reactionText: REACTION })
      await answer(AMARA_SECOND_PROFILE, { choices: ['reaction'], reactionText: REACTION })

      expect(queued().map((q) => q.delaySeconds)).toEqual([0, 0])
    })
  })

  describe('when the queue is down', () => {
    it('saves the answer as pending, still answers it, and logs the failure without the words, the error\'s message or anyone\'s text', async () => {
      const spies = spyOnConsole()
      jobs.failNextWith(new Error('queue is down ZZ9'))

      const view = await set(AMARA, { choices: ['reaction'], reactionText: 'Caro White QZ7' })

      expect(view.reactionText).toBe('Caro White QZ7')
      const stored = (await repository.current('profile-amara-1'))!
      expect(stored).toMatchObject({ parseState: 'pending', parseDueAt: T0 })
      expect(jobs.enqueued).toEqual([])
      const logged = loggedBy(spies)
      expect(logged.length).toBeGreaterThan(0)
      for (const line of logged) {
        expect(line).not.toContain('QZ7')
        expect(line).not.toContain('ZZ9')
      }
    })
  })
})

describe('SafetyService.current repairing a parse that never ran', () => {
  const GRACE = 10 * MINUTE

  /** Saves words at T0 (so due at T0), forgets the message the way a lost queue message is forgotten, and returns the row id. */
  const lost = async () => {
    const safetyId = await reactionAnswer()
    jobs.enqueued.length = 0
    return safetyId
  }

  it('queues the parse again, with the same id and no delay, when the row is still pending more than 10 minutes after it was due', async () => {
    const safetyId = await lost()
    setClock(GRACE + 1)

    await current(AMARA)

    expect(queued()).toEqual([{ job: 'parse-safety', body: { safetyId }, delaySeconds: 0 }])
  })

  it('waits while the row is within 10 minutes of its due time, exactly 10 minutes included (the boundary)', async () => {
    await lost()

    setClock(GRACE - 1)
    await current(AMARA)
    setClock(GRACE)
    await current(AMARA)

    expect(jobs.enqueued).toEqual([])
  })

  it('measures from the due time, not from when the answer was saved: a parse held back for the hour is not overdue early', async () => {
    await reactionAnswer()
    setClock(10 * MINUTE)
    const second = await reactionAnswer('Movate cream') // due 50 minutes later, at T0 + 1 hour
    jobs.enqueued.length = 0

    setClock(HOUR + GRACE)
    await current(AMARA)
    expect(jobs.enqueued).toEqual([])

    setClock(HOUR + GRACE + 1)
    await current(AMARA)
    expect(queued()).toEqual([{ job: 'parse-safety', body: { safetyId: second }, delaySeconds: 0 }])
  })

  it.each(['done', 'failed', 'none'] as const)('never queues a row whose parse state is %s, however late', async (state) => {
    const safetyId = await lost()
    await repository.setParseState(safetyId, state)
    setClock(7 * 24 * HOUR)

    await current(AMARA)

    expect(jobs.enqueued).toEqual([])
  })

  it('looks only at the current answer: an overdue pending row that a newer answer replaced is left alone', async () => {
    await lost()
    setClock(5 * MINUTE)
    await set(AMARA, { choices: ['none'] })
    setClock(2 * HOUR)

    await current(AMARA)

    expect(jobs.enqueued).toEqual([])
  })

  it('answers the same view as without the repair', async () => {
    await lost()
    const before = await current(AMARA)
    setClock(GRACE + 1)

    expect(await current(AMARA)).toEqual(before)
  })

  it('never fails the read when the queue is down, and logs no words', async () => {
    await lost()
    setClock(GRACE + 1)
    const spies = spyOnConsole()
    jobs.failNextWith(new Error('queue is down ZZ9'))

    const view = await current(AMARA)

    expect(view.reactionText).toBe(REACTION)
    for (const line of loggedBy(spies)) {
      expect(line).not.toContain('fragrance')
      expect(line).not.toContain('ZZ9')
    }
  })

})

describe('SafetyService.parse reading the words', () => {
  it('reads the reaction words and then the prescription words, each as saved', async () => {
    const safetyId = await bothAnswer()

    await parse(safetyId)

    expect(reader.calls).toEqual([REACTION, PRESCRIPTION])
  })

  it('reads only the words there are', async () => {
    const reaction = await reactionAnswer()
    await parse(reaction)
    expect(reader.calls).toEqual([REACTION])

    reader.calls.length = 0
    setClock(HOUR)
    const prescription = await answer(AMARA, { choices: ['prescription'], prescriptionText: PRESCRIPTION })
    await parse(prescription)
    expect(reader.calls).toEqual([PRESCRIPTION])
  })

  it('stores every mention with where it came from and its place in the order the reader gave them, counted on through the second text', async () => {
    readerSays({
      [REACTION]: [product('Caro White'), ingredient('fragrance')],
      [PRESCRIPTION]: [product('Dermovate'), ingredient('clobetasol')],
    })
    const safetyId = await bothAnswer()

    await parse(safetyId)

    expect((await mentionsOf(safetyId)).map((m) => [m.position, m.source, m.kind, m.name])).toEqual([
      [0, 'reaction', 'product', 'Caro White'],
      [1, 'reaction', 'ingredient', 'fragrance'],
      [2, 'prescription', 'product', 'Dermovate'],
      [3, 'prescription', 'ingredient', 'clobetasol'],
    ])
  })

  it('stores a product with the brand, name, variant (null when it has none) and category the reader gave', async () => {
    readerSays({ [REACTION]: [product('Caro White', { variant: 'Extra' }), product('Movate', { brand: null, category: null })] })
    const safetyId = await reactionAnswer()

    await parse(safetyId)

    expect(await mentionsOf(safetyId)).toMatchObject([
      { kind: 'product', brand: 'Caro White', name: 'Caro White', variant: 'Extra', category: 'skin' },
      { kind: 'product', brand: null, name: 'Movate', variant: null, category: null },
    ])
  })

  it('stores an ingredient with its name alone and no resolution, and never sends it to the catalog', async () => {
    readerSays({ [REACTION]: [ingredient('fragrance')] })
    const safetyId = await reactionAnswer()

    await parse(safetyId)

    expect(await mentionsOf(safetyId)).toMatchObject([{ kind: 'ingredient', brand: null, name: 'fragrance', variant: null, category: null, productId: null, resolution: null }])
    expect(catalog.resolved).toEqual([])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
  })

  it('is done at once when the reader found nothing named: the words and the tick still count on their own', async () => {
    const safetyId = await reactionAnswer('the white tub from the market')

    await parse(safetyId)

    expect(await mentionsOf(safetyId)).toEqual([])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
    expect(catalog.resolved).toEqual([])
  })

  it('works as a system actor, with no user in the session', async () => {
    readerSays({ [REACTION]: [ingredient('fragrance')] })
    const safetyId = await reactionAnswer()

    await expect(runAs(SYSTEM, () => service.parse(safetyId))).resolves.toBeUndefined()
  })
})

describe('SafetyService.parse when the reader cannot read', () => {
  it.each([
    ['refuses', () => new AnthropicRefusalError('refusal')],
    ['rejects the request', () => new AnthropicRequestError('request-rejected')],
  ])('finishes with no mentions, rather than failing, when the model %s', async (_label, makeError) => {
    reader.failNextWith(makeError())
    const safetyId = await reactionAnswer()

    await expect(parse(safetyId)).resolves.toBeUndefined()

    expect(await mentionsOf(safetyId)).toEqual([])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
  })

  it('keeps what the other text gave when the model refuses one of the two', async () => {
    reader.failNextWith(new AnthropicRefusalError('refusal'))
    readerSays({ [PRESCRIPTION]: [product('Dermovate')] })
    const safetyId = await bothAnswer()

    await parse(safetyId)

    expect(await shape(safetyId)).toEqual([['Dermovate', 'resolved', 'product-Dermovate']])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
  })

  it.each([
    ['the AI budget is spent', () => new AiBudgetExceededError('cap')],
    ['Claude is unavailable', () => new AnthropicUnavailableError('unavailable')],
  ])('throws that error, leaving the row pending, when %s, so the job retries', async (_label, makeError) => {
    const error = makeError()
    reader.failNextWith(error)
    const safetyId = await reactionAnswer()

    expect(await errorOf(parse(safetyId))).toBe(error)

    expect(await mentionsOf(safetyId)).toEqual([])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'pending' })
  })

  it('reads again on the retry, because nothing was stored, and then finishes', async () => {
    readerSays({ [REACTION]: [product('Caro White')] })
    reader.failNextWith(new AiBudgetExceededError('cap'))
    const safetyId = await reactionAnswer()
    await errorOf(parse(safetyId))

    await parse(safetyId)

    expect(await shape(safetyId)).toEqual([['Caro White', 'resolved', 'product-Caro White']])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
  })

  it('stores nothing from the first text when the second cannot be read yet, so a retry cannot lose what the second text names', async () => {
    const safetyId = await bothAnswer()
    // The first read works; the second is the next call to fail.
    let calls = 0
    reader.respondWith((text) => {
      if (++calls === 2) throw new AiBudgetExceededError('cap')
      return text === REACTION ? [product('Caro White')] : [product('Dermovate')]
    })

    await errorOf(parse(safetyId))
    expect(await mentionsOf(safetyId)).toEqual([])

    await parse(safetyId)
    expect((await mentionsOf(safetyId)).map((m) => [m.source, m.name])).toEqual([
      ['reaction', 'Caro White'],
      ['prescription', 'Dermovate'],
    ])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
  })
})

describe('SafetyService.parse resolving products in the catalog', () => {
  it('asks the catalog who each product is by its brand, name and category, and its variant when it has one', async () => {
    readerSays({ [REACTION]: [product('Caro White'), product('Movate', { variant: 'Fort', category: 'body' })] })

    await parse(await reactionAnswer())

    expect(catalog.resolved).toEqual([
      { brand: 'Caro White', name: 'Caro White', category: 'skin' },
      { brand: 'Movate', name: 'Movate', category: 'body', variant: 'Fort' },
    ])
  })

  it.each(['ready', 'needs-analysis', 'analysis-failed'] as const)('marks a product resolved to the catalog\'s product when the catalog says %s, without researching it', async (kind) => {
    catalog.onResolve = () => ({ kind, productId: 'product-9', formulationId: 'formulation-9' })
    readerSays({ [REACTION]: [product('Caro White')] })
    const safetyId = await reactionAnswer()

    await parse(safetyId)

    expect(await shape(safetyId)).toEqual([['Caro White', 'resolved', 'product-9']])
    expect(catalog.researched).toEqual([])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
  })

  it('researches a product the catalog does not have ingredients for, and marks it resolved when the research finds them', async () => {
    catalog.onResolve = () => ({ kind: 'needs-research', productId: 'product-9' })
    readerSays({ [REACTION]: [product('Caro White')] })
    const safetyId = await reactionAnswer()

    await parse(safetyId)

    expect(catalog.researched).toEqual(['product-9'])
    expect(await shape(safetyId)).toEqual([['Caro White', 'resolved', 'product-9']])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
  })

  it('marks a product unresolved, keeping the catalog\'s product id, when research finds no ingredients, and finishes', async () => {
    catalog.onResolve = () => ({ kind: 'needs-research', productId: 'product-9' })
    catalog.onResearch = () => ({ kind: 'not-found' })
    readerSays({ [REACTION]: [product('Caro White')] })
    const safetyId = await reactionAnswer()

    await parse(safetyId)

    expect(await shape(safetyId)).toEqual([['Caro White', 'unresolved', 'product-9']])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
  })

  it('does not take a stale fallback formulation for an answer: not-found is unresolved even when the catalog offers one', async () => {
    catalog.onResolve = () => ({ kind: 'needs-research', productId: 'product-9' })
    catalog.onResearch = () => ({ kind: 'not-found', fallbackFormulationId: 'formulation-old' })
    readerSays({ [REACTION]: [product('Caro White')] })
    const safetyId = await reactionAnswer()

    await parse(safetyId)

    expect((await mentionsOf(safetyId))[0]).toMatchObject({ resolution: 'unresolved' })
  })

  it('throws, leaving the row and the product pending, when research cannot run because a budget is spent, so the job retries later', async () => {
    catalog.onResolve = () => ({ kind: 'needs-research', productId: 'product-9' })
    catalog.onResearch = () => ({ kind: 'budget-exhausted' })
    readerSays({ [REACTION]: [product('Caro White')] })
    const safetyId = await reactionAnswer()

    const error = await errorOf(parse(safetyId))

    expect(error).not.toBeInstanceOf(PermanentJobError)
    expect(await shape(safetyId)).toEqual([['Caro White', 'pending', null]])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'pending' })
  })

  it('throws ResearchInProgressError as it is, leaving the product pending, when someone else is researching it', async () => {
    catalog.onResolve = () => ({ kind: 'needs-research', productId: 'product-9' })
    const busy = new ResearchInProgressError()
    catalog.onResearch = () => {
      throw busy
    }
    readerSays({ [REACTION]: [product('Caro White')] })
    const safetyId = await reactionAnswer()

    expect(await errorOf(parse(safetyId))).toBe(busy)

    expect((await mentionsOf(safetyId))[0]).toMatchObject({ resolution: 'pending' })
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'pending' })
  })

  it('throws CatalogBusyError as it is, leaving the product pending, when the catalog cannot say whether it knows the product', async () => {
    const busy = new CatalogBusyError()
    catalog.onResolve = () => {
      throw busy
    }
    readerSays({ [REACTION]: [product('Caro White')] })
    const safetyId = await reactionAnswer()

    expect(await errorOf(parse(safetyId))).toBe(busy)

    expect((await mentionsOf(safetyId))[0]).toMatchObject({ resolution: 'pending' })
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'pending' })
  })

  it.each([
    ['no brand', { brand: null }],
    ['no category', { category: null }],
    ['neither', { brand: null, category: null }],
  ])('marks a product with %s unresolved without asking the catalog about it, since the catalog needs both', async (_label, over) => {
    readerSays({ [REACTION]: [product('Movate cream', over)] })
    const safetyId = await reactionAnswer()

    await parse(safetyId)

    expect(await shape(safetyId)).toEqual([['Movate cream', 'unresolved', null]])
    expect(catalog.resolved).toEqual([])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
  })
})

describe('SafetyService.parse and the limit of three products', () => {
  const FOUR = [product('Caro White'), product('Carotone'), product('Movate'), product('Dermovate')]

  it('resolves the first three products and marks the fourth unresolved without asking the catalog about it (the boundary: 3 and 4)', async () => {
    readerSays({ [REACTION]: FOUR })
    const safetyId = await reactionAnswer()

    await parse(safetyId)

    expect(await shape(safetyId)).toEqual([
      ['Caro White', 'resolved', 'product-Caro White'],
      ['Carotone', 'resolved', 'product-Carotone'],
      ['Movate', 'resolved', 'product-Movate'],
      ['Dermovate', 'unresolved', null],
    ])
    expect(catalog.resolved.map((i) => i.name)).toEqual(['Caro White', 'Carotone', 'Movate'])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
  })

  it('resolves exactly three when exactly three are named', async () => {
    readerSays({ [REACTION]: FOUR.slice(0, 3) })

    await parse(await reactionAnswer())

    expect(catalog.resolved).toHaveLength(3)
  })

  it('counts the products of both texts together, in the order they were read', async () => {
    readerSays({ [REACTION]: [product('Caro White'), product('Carotone')], [PRESCRIPTION]: [product('Movate'), product('Dermovate')] })
    const safetyId = await bothAnswer()

    await parse(safetyId)

    expect(await shape(safetyId)).toEqual([
      ['Caro White', 'resolved', 'product-Caro White'],
      ['Carotone', 'resolved', 'product-Carotone'],
      ['Movate', 'resolved', 'product-Movate'],
      ['Dermovate', 'unresolved', null],
    ])
  })

  it('does not count ingredients', async () => {
    readerSays({ [REACTION]: [ingredient('fragrance'), product('Caro White'), ingredient('lanolin'), product('Carotone'), ingredient('parabens'), product('Movate')] })
    const safetyId = await reactionAnswer()

    await parse(safetyId)

    expect(catalog.resolved.map((i) => i.name)).toEqual(['Caro White', 'Carotone', 'Movate'])
  })

  it('does not spend one of the three on a product that has no brand or category, which the catalog cannot take anyway', async () => {
    readerSays({ [REACTION]: [product('white tub', { brand: null }), product('Caro White'), product('Carotone'), product('Movate'), product('Dermovate')] })
    const safetyId = await reactionAnswer()

    await parse(safetyId)

    expect(catalog.resolved.map((i) => i.name)).toEqual(['Caro White', 'Carotone', 'Movate'])
    expect((await mentionsOf(safetyId)).map((m) => [m.name, m.resolution])).toEqual([
      ['white tub', 'unresolved'],
      ['Caro White', 'resolved'],
      ['Carotone', 'resolved'],
      ['Movate', 'resolved'],
      ['Dermovate', 'unresolved'],
    ])
  })
})

describe('SafetyService.parse being run again', () => {
  it('does not read again when mentions are already stored: the retry only carries on resolving', async () => {
    readerSays({ [REACTION]: [product('Caro White'), product('Carotone'), product('Movate')] })
    const busy = new CatalogBusyError()
    catalog.onResolve = (identity) => {
      if (identity.name === 'Carotone' && catalog.resolved.filter((i) => i.name === 'Carotone').length === 1) throw busy
      return { kind: 'ready', productId: `product-${identity.name}`, formulationId: 'f' }
    }
    const safetyId = await reactionAnswer()
    expect(await errorOf(parse(safetyId))).toBe(busy)
    expect(reader.calls).toHaveLength(1)

    await parse(safetyId)

    expect(reader.calls).toHaveLength(1)
    expect(await shape(safetyId)).toEqual([
      ['Caro White', 'resolved', 'product-Caro White'],
      ['Carotone', 'resolved', 'product-Carotone'],
      ['Movate', 'resolved', 'product-Movate'],
    ])
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
  })

  it('keeps what was already resolved and asks the catalog only about the products still pending', async () => {
    readerSays({ [REACTION]: [product('Caro White'), product('Carotone')] })
    let failOnce = true
    catalog.onResolve = (identity) => {
      if (identity.name === 'Carotone' && failOnce) {
        failOnce = false
        throw new CatalogBusyError()
      }
      return { kind: 'ready', productId: `product-${identity.name}`, formulationId: 'f' }
    }
    const safetyId = await reactionAnswer()
    await errorOf(parse(safetyId))
    catalog.resolved.length = 0

    await parse(safetyId)

    expect(catalog.resolved.map((i) => i.name)).toEqual(['Carotone'])
  })

  it('still leaves the fourth product unresolved on a retry, and resolves no more than three in all', async () => {
    readerSays({ [REACTION]: [product('Caro White'), product('Carotone'), product('Movate'), product('Dermovate')] })
    let failOnce = true
    catalog.onResolve = (identity) => {
      if (identity.name === 'Carotone' && failOnce) {
        failOnce = false
        throw new CatalogBusyError()
      }
      return { kind: 'ready', productId: `product-${identity.name}`, formulationId: 'f' }
    }
    const safetyId = await reactionAnswer()
    await errorOf(parse(safetyId))

    await parse(safetyId)

    expect((await mentionsOf(safetyId)).map((m) => [m.name, m.resolution])).toEqual([
      ['Caro White', 'resolved'],
      ['Carotone', 'resolved'],
      ['Movate', 'resolved'],
      ['Dermovate', 'unresolved'],
    ])
    expect(new Set(catalog.resolved.map((i) => i.name))).toEqual(new Set(['Caro White', 'Carotone', 'Movate']))
  })

  it('asks the catalog about a product again, from the start, when its research could not run the first time', async () => {
    readerSays({ [REACTION]: [product('Caro White')] })
    catalog.onResolve = () => ({ kind: 'needs-research', productId: 'product-9' })
    let outcomes: ResearchResult[] = [{ kind: 'budget-exhausted' }, { kind: 'found', formulationId: 'formulation-9' }]
    catalog.onResearch = () => outcomes.shift()!
    const safetyId = await reactionAnswer()
    await errorOf(parse(safetyId))

    await parse(safetyId)

    expect(await shape(safetyId)).toEqual([['Caro White', 'resolved', 'product-9']])
    expect(reader.calls).toHaveLength(1)
    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
  })

  it('does nothing for a row that is already done: no reading, no catalog, and no change', async () => {
    readerSays({ [REACTION]: [product('Caro White')] })
    const safetyId = await reactionAnswer()
    await parse(safetyId)
    reader.calls.length = 0
    catalog.resolved.length = 0

    await parse(safetyId)

    expect(reader.calls).toEqual([])
    expect(catalog.resolved).toEqual([])
    expect(await shape(safetyId)).toEqual([['Caro White', 'resolved', 'product-Caro White']])
  })

  it('does not read again for a row done with no mentions at all', async () => {
    const safetyId = await reactionAnswer('the white tub from the market')
    await parse(safetyId)
    reader.calls.length = 0

    await parse(safetyId)

    expect(reader.calls).toEqual([])
  })
})

describe('SafetyService.parse for a row that is not the current answer', () => {
  it('marks the row done and stops, calling neither the reader nor the catalog, when a newer answer has replaced it: that one has its own job', async () => {
    const older = await reactionAnswer()
    setClock(5 * MINUTE)
    await answer(AMARA, { choices: ['reaction'], reactionText: 'Movate cream' })

    await parse(older)

    expect(reader.calls).toEqual([])
    expect(catalog.resolved).toEqual([])
    expect(await mentionsOf(older)).toEqual([])
    expect(await rowOf(older)).toMatchObject({ parseState: 'done' })
  })

  it('parses the newer answer when it is the one asked for', async () => {
    await reactionAnswer()
    setClock(5 * MINUTE)
    const newer = await answer(AMARA, { choices: ['reaction'], reactionText: 'Movate cream' })

    await parse(newer)

    expect(reader.calls).toEqual(['Movate cream'])
    expect(await rowOf(newer)).toMatchObject({ parseState: 'done' })
  })

  it('is current for its own profile only: an answer on another profile does not replace it', async () => {
    const amaras = await reactionAnswer()
    await answer(TOLU, { choices: ['reaction'], reactionText: 'Movate cream' })

    await parse(amaras)

    expect(reader.calls).toEqual([REACTION])
  })

  it('does nothing, and does not fail, for a row that does not exist', async () => {
    await expect(parse('safety-that-was-never-saved')).resolves.toBeUndefined()

    expect(reader.calls).toEqual([])
    expect(catalog.resolved).toEqual([])
  })
})

describe('SafetyService.markParseFailed', () => {
  it('marks a pending row failed, which is where the job lands when its retries run out', async () => {
    const safetyId = await reactionAnswer()

    await markParseFailed(safetyId)

    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'failed' })
  })

  it('keeps the words and the choices as they were: a failed parse takes nothing away', async () => {
    const safetyId = await reactionAnswer()

    await markParseFailed(safetyId)

    expect(await rowOf(safetyId)).toMatchObject({ choices: ['reaction'], reactionText: REACTION })
    expect(await current(AMARA)).toMatchObject({ choices: ['reaction'], reactionText: REACTION })
  })

  it('does not undo a parse that finished', async () => {
    readerSays({ [REACTION]: [ingredient('fragrance')] })
    const safetyId = await reactionAnswer()
    await parse(safetyId)

    await markParseFailed(safetyId)

    expect(await rowOf(safetyId)).toMatchObject({ parseState: 'done' })
  })

  it('does not fail for a row that does not exist', async () => {
    await expect(markParseFailed('safety-that-was-never-saved')).resolves.toBeUndefined()
  })
})

describe('SafetyService.currentMentions', () => {
  it('answers the mentions parsed from the current answer, in order, with where each came from and how it resolved', async () => {
    readerSays({ [REACTION]: [product('Caro White'), ingredient('fragrance')], [PRESCRIPTION]: [product('Movate', { brand: null })] })
    await parse(await bothAnswer())

    const mentions = await currentMentions(AMARA)

    expect(mentions).toMatchObject([
      { source: 'reaction', kind: 'product', brand: 'Caro White', name: 'Caro White', variant: null, category: 'skin', productId: 'product-Caro White', resolution: 'resolved' },
      { source: 'reaction', kind: 'ingredient', brand: null, name: 'fragrance', variant: null, category: null, productId: null, resolution: null },
      { source: 'prescription', kind: 'product', brand: null, name: 'Movate', productId: null, resolution: 'unresolved' },
    ])
  })

  it('answers the mentions as they stand, a product still pending included, while the parse is part way', async () => {
    readerSays({ [REACTION]: [product('Caro White')] })
    catalog.onResolve = () => {
      throw new CatalogBusyError()
    }
    const safetyId = await reactionAnswer()
    await errorOf(parse(safetyId))

    expect(await currentMentions(AMARA)).toMatchObject([{ name: 'Caro White', resolution: 'pending' }])
  })

  it('answers nothing for an answer that has not been parsed, or has no words', async () => {
    await reactionAnswer()
    expect(await currentMentions(AMARA)).toEqual([])

    await set(TOLU, { choices: ['pregnant'] })
    expect(await currentMentions(TOLU)).toEqual([])
  })

  it('answers nothing for a profile that never answered', async () => {
    expect(await currentMentions(AMARA)).toEqual([])
  })

  it('answers the mentions of the current answer only, not those of the answers before it', async () => {
    readerSays({ [REACTION]: [product('Caro White')], 'Movate cream': [product('Movate')] })
    await parse(await reactionAnswer())
    setClock(HOUR)
    await parse(await answer(AMARA, { choices: ['reaction'], reactionText: 'Movate cream' }))

    expect((await currentMentions(AMARA)).map((m) => m.name)).toEqual(['Movate'])
  })

  it('answers the mentions of the caller\'s profile only', async () => {
    readerSays({ [REACTION]: [product('Caro White')] })
    await parse(await reactionAnswer())

    expect(await currentMentions(TOLU)).toEqual([])
    expect(await currentMentions(AMARA_SECOND_PROFILE)).toEqual([])
  })

  it('answers 401 AUTH_REQUIRED without a session', async () => {
    expect((await errorOf(currentMentions(PUBLIC))).code).toBe('AUTH_REQUIRED')
  })
})

describe('SafetyView stays as the app knows it', () => {
  it('carries no parse state and no mentions, before or after the parse', async () => {
    readerSays({ [REACTION]: [product('Caro White')] })
    const safetyId = await reactionAnswer()
    const before = await current(AMARA)
    await parse(safetyId)
    const after = await current(AMARA)

    for (const view of [before, after]) expect(Object.keys(view).sort()).toEqual(['choices', 'excludesPregnancyCaution', 'prescriptionText', 'reactionText', 'updatedAt'])
  })
})

describe('SafetyService parse logging', () => {
  it('never logs the words, a brand or a name, through reading, resolving, research, a retry or a stale row', async () => {
    const spies = spyOnConsole()
    const words = 'QZ7 Brand Caro and QZ7 fragrance'
    readerSays({ [words]: [product('QZ7 Brand Caro'), product('QZ7 Brand Two'), ingredient('QZ7 fragrance')] })
    catalog.onResolve = (identity) => (identity.name === 'QZ7 Brand Two' ? { kind: 'needs-research', productId: 'product-QZ7' } : { kind: 'ready', productId: 'product-1', formulationId: 'f' })
    catalog.onResearch = () => ({ kind: 'not-found' })
    const safetyId = await reactionAnswer(words)
    reader.failNextWith(new AnthropicUnavailableError('unavailable'))
    await errorOf(parse(safetyId))
    await parse(safetyId)
    await parse(safetyId)
    setClock(HOUR)
    await answer(AMARA, { choices: ['reaction'], reactionText: `${words} again` })
    await parse(safetyId)
    await markParseFailed(safetyId)
    await currentMentions(AMARA)

    for (const line of loggedBy(spies)) expect(line).not.toContain('QZ7')
  })

  it('logs nothing when a parse goes through', async () => {
    const spies = spyOnConsole()
    readerSays({ [REACTION]: [product('Caro White'), ingredient('fragrance')] })

    await parse(await reactionAnswer())

    expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([])
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import type { Mention } from '../../providers/mention-reading/mention-reader.provider'
import { MemoryMentionReader } from '../../providers/mention-reading/memory.mention-reader'
import type { ProductIdentity } from '../../providers/product-research/product-researcher.provider'
import type { ResearchResult, ResolveResult } from '../catalog/catalog.service'
import { toSafetyResponse } from './safety.presenter'
import { FakeSafetyRepository } from './safety.repository.fake'
import { SafetyService } from './safety.service'

// A product the person keeps reacting to, marked by the skin-care module (source `skin-log`), and what it takes to keep that mark: it lands on the profile's
// current safety row, a later PUT /safety carries it onto the new row, and nothing else is carried. The parse of typed words (safety.service.parse.test.ts) is the
// real one here, so a row has the reaction and prescription mentions it really gets.

// The one clock every test hangs off; later times are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

const actor = (userId: string, profileId: string): Actor => ({ kind: 'user', userId, status: 'anonymous', profileId })
// Amara and Tolu are two accounts; Amara has a second profile.
const AMARA = actor('user-amara', 'profile-amara-1')
const AMARA_SECOND_PROFILE = actor('user-amara', 'profile-amara-2')
const TOLU = actor('user-tolu', 'profile-tolu-1')
const SYSTEM: Actor = { kind: 'system', job: 'parse-safety' }
const PUBLIC: Actor = { kind: 'public' }

const REACTION = 'Caro White and fragrance'
const PRESCRIPTION = 'Dermovate from my dermatologist'

const NIGHT = { productId: 'product-night', brand: 'Orbis', name: 'Night Cream', category: 'skin' } as const
const DAY = { productId: 'product-day', brand: 'Orbis', name: 'Day Cream', category: 'skin' } as const

// Every named product is in the catalog and ready, with an id made from its name.
const catalog = {
  resolve: async (identity: ProductIdentity): Promise<ResolveResult> => ({ kind: 'ready', productId: `product-${identity.name}`, formulationId: `formulation-${identity.name}` }),
  research: async (productId: string): Promise<ResearchResult> => ({ kind: 'found', formulationId: `formulation-${productId}` }),
}
const product = (name: string): Mention => ({ kind: 'product', brand: name, name, category: 'skin' })

let clock: Date
let repository: FakeSafetyRepository
let reader: MemoryMentionReader
let service: SafetyService

type SetInput = Parameters<SafetyService['set']>[0]
const set = (who: Actor, input: SetInput) => runAs(who, () => service.set(input))
const current = (who: Actor) => runAs(who, () => service.current())
/** The mentions a verdict or a job sees for the profile: all of its current row, no session needed. */
const mentionsOf = async (profileId: string) => (await service.snapshotFor(profileId)).mentions
const skinLogOf = async (profileId: string) => (await mentionsOf(profileId)).filter((mention) => mention.source === 'skin-log')
const sourcesOf = async (profileId: string) => (await mentionsOf(profileId)).map((mention) => mention.source)
const idOfCurrent = async (profileId: string) => (await repository.current(profileId))!.id

/** Saves words and runs the real parse of them, so the row has the reaction and prescription mentions it really gets. */
const parsedAnswer = async (who: Actor, input: SetInput) => {
  await set(who, input)
  if (who.kind !== 'user') throw new Error('an answer needs a user')
  const safetyId = await idOfCurrent(who.profileId)
  await runAs(SYSTEM, () => service.parse(safetyId))
}

const tick = () => {
  clock = new Date(clock.getTime() + MINUTE)
}

beforeEach(() => {
  clock = T0
  repository = new FakeSafetyRepository()
  reader = new MemoryMentionReader()
  reader.respondWith((text) => (text === REACTION ? [product('Caro White')] : text === PRESCRIPTION ? [product('Dermovate')] : []))
  let n = 0
  service = new SafetyService({ repository, reader, catalog, jobs: new MemoryJobQueue(), now: () => clock, newId: () => `id-${++n}` })
})

describe('SafetyService.markReactionProduct', () => {
  it('adds a resolved product mention with source skin-log to the profile\'s current safety row', async () => {
    await set(AMARA, { choices: ['none'] })

    const result = await service.markReactionProduct('profile-amara-1', NIGHT)

    expect(result).toEqual({ marked: true })
    expect(await mentionsOf('profile-amara-1')).toMatchObject([
      { safetyId: await idOfCurrent('profile-amara-1'), source: 'skin-log', kind: 'product', brand: 'Orbis', name: 'Night Cream', category: 'skin', productId: 'product-night', resolution: 'resolved' },
    ])
  })

  it('needs no session: a job with no user, and the public actor, can mark', async () => {
    await set(AMARA, { choices: ['none'] })

    await service.markReactionProduct('profile-amara-1', NIGHT)
    await runAs(PUBLIC, () => service.markReactionProduct('profile-amara-1', DAY))

    expect((await skinLogOf('profile-amara-1')).map((mention) => mention.productId)).toEqual(['product-night', 'product-day'])
  })

  it('adds nothing the second time the same product is marked', async () => {
    await set(AMARA, { choices: ['none'] })
    await service.markReactionProduct('profile-amara-1', NIGHT)

    const again = await service.markReactionProduct('profile-amara-1', NIGHT)

    expect(again).toEqual({ marked: false })
    expect(await skinLogOf('profile-amara-1')).toHaveLength(1)
  })

  it('keeps one mention for each different product marked', async () => {
    await set(AMARA, { choices: ['none'] })

    await service.markReactionProduct('profile-amara-1', NIGHT)
    await service.markReactionProduct('profile-amara-1', DAY)

    expect((await skinLogOf('profile-amara-1')).map((mention) => mention.productId).sort()).toEqual(['product-day', 'product-night'])
  })

  it('does nothing, and says so, for a profile with no safety row', async () => {
    const result = await service.markReactionProduct('profile-amara-1', NIGHT)

    expect(result).toEqual({ marked: false })
    expect(await repository.history('profile-amara-1')).toEqual([])
    expect(await mentionsOf('profile-amara-1')).toEqual([])
  })

  it('marks only the profile it was asked about', async () => {
    await set(AMARA, { choices: ['none'] })
    await set(AMARA_SECOND_PROFILE, { choices: ['none'] })
    await set(TOLU, { choices: ['none'] })

    await service.markReactionProduct('profile-amara-1', NIGHT)

    expect(await skinLogOf('profile-amara-2')).toEqual([])
    expect(await skinLogOf('profile-tolu-1')).toEqual([])
  })

  it('keeps the mentions the parse found, and adds the mark after them', async () => {
    await parsedAnswer(AMARA, { choices: ['reaction'], reactionText: REACTION })

    await service.markReactionProduct('profile-amara-1', NIGHT)

    expect(await sourcesOf('profile-amara-1')).toEqual(['reaction', 'skin-log'])
  })

  it('writes no new safety row and leaves the view as it was: the view is choices and texts, never the marks', async () => {
    await set(AMARA, { choices: ['reaction'], reactionText: REACTION })
    tick()
    const before = await current(AMARA)
    const rowBefore = await idOfCurrent('profile-amara-1')

    await service.markReactionProduct('profile-amara-1', NIGHT)

    const after = await current(AMARA)
    expect(after).toEqual(before)
    expect(Object.keys(after).sort()).toEqual(['choices', 'excludesPregnancyCaution', 'prescriptionText', 'reactionText', 'updatedAt'])
    expect(await idOfCurrent('profile-amara-1')).toBe(rowBefore)
    expect(await repository.history('profile-amara-1')).toHaveLength(1)
    // What GET /safety sends.
    expect(JSON.stringify(toSafetyResponse(after))).not.toMatch(/skin-log|Night Cream|product-night/)
  })
})

describe('SafetyService: marks and the three-product limit of the parse', () => {
  const TYPED = 'Caro White, Skin Doctor and Carotone'

  it('does not let a carried mark use a slot: three typed products are all looked up after a save that carries a mark', async () => {
    reader.respondWith((text) => (text === TYPED ? [product('Caro White'), product('Skin Doctor'), product('Carotone')] : []))
    await set(AMARA, { choices: ['none'] })
    await service.markReactionProduct('profile-amara-1', NIGHT)
    tick()

    await parsedAnswer(AMARA, { choices: ['reaction'], reactionText: TYPED })

    const typed = (await mentionsOf('profile-amara-1')).filter((mention) => mention.source === 'reaction')
    expect(typed.map((mention) => [mention.resolution, mention.productId])).toEqual([
      ['resolved', 'product-Caro White'],
      ['resolved', 'product-Skin Doctor'],
      ['resolved', 'product-Carotone'],
    ])
    expect(await skinLogOf('profile-amara-1')).toHaveLength(1)
  })

  it('still leaves a fourth typed product unresolved: the limit is three typed products, marks or none', async () => {
    reader.respondWith((text) => (text === TYPED ? [product('Caro White'), product('Skin Doctor'), product('Carotone'), product('Fair & White')] : []))
    await set(AMARA, { choices: ['none'] })
    await service.markReactionProduct('profile-amara-1', NIGHT)
    tick()

    await parsedAnswer(AMARA, { choices: ['reaction'], reactionText: TYPED })

    const typed = (await mentionsOf('profile-amara-1')).filter((mention) => mention.source === 'reaction')
    expect(typed.map((mention) => mention.resolution)).toEqual(['resolved', 'resolved', 'resolved', 'unresolved'])
  })
})

describe('SafetyService.set carrying the marks forward', () => {
  it('puts the marked product on the new row when the safety answers are saved again', async () => {
    await set(AMARA, { choices: ['none'] })
    await service.markReactionProduct('profile-amara-1', NIGHT)
    tick()

    await set(AMARA, { choices: ['pregnant'] })

    const newRowId = await idOfCurrent('profile-amara-1')
    expect(newRowId).not.toBe('id-1')
    expect(await skinLogOf('profile-amara-1')).toMatchObject([{ safetyId: newRowId, source: 'skin-log', kind: 'product', name: 'Night Cream', productId: 'product-night', resolution: 'resolved' }])
  })

  it('carries it through a second save too, from the row that carried it', async () => {
    await set(AMARA, { choices: ['none'] })
    await service.markReactionProduct('profile-amara-1', NIGHT)
    tick()
    await set(AMARA, { choices: ['pregnant'] })
    tick()

    await set(AMARA, { choices: ['breastfeeding'] })

    expect((await skinLogOf('profile-amara-1')).map((mention) => mention.productId)).toEqual(['product-night'])
  })

  it('carries every product marked, once each', async () => {
    await set(AMARA, { choices: ['none'] })
    await service.markReactionProduct('profile-amara-1', NIGHT)
    await service.markReactionProduct('profile-amara-1', DAY)
    tick()

    await set(AMARA, { choices: ['pregnant'] })

    expect((await skinLogOf('profile-amara-1')).map((mention) => mention.productId).sort()).toEqual(['product-day', 'product-night'])
  })

  it('does not mark again a product that was marked before the save', async () => {
    await set(AMARA, { choices: ['none'] })
    await service.markReactionProduct('profile-amara-1', NIGHT)
    tick()
    await set(AMARA, { choices: ['pregnant'] })

    const again = await service.markReactionProduct('profile-amara-1', NIGHT)

    expect(again).toEqual({ marked: false })
    expect(await skinLogOf('profile-amara-1')).toHaveLength(1)
  })

  it('leaves the old row\'s own mention where it was (history is kept)', async () => {
    await set(AMARA, { choices: ['none'] })
    await service.markReactionProduct('profile-amara-1', NIGHT)
    tick()

    await set(AMARA, { choices: ['pregnant'] })

    expect(await repository.mentions('id-1')).toMatchObject([{ source: 'skin-log', productId: 'product-night' }])
  })

  it('carries the mark onto a save that has words, and the new words are still parsed on their own', async () => {
    await set(AMARA, { choices: ['none'] })
    await service.markReactionProduct('profile-amara-1', NIGHT)
    tick()

    await parsedAnswer(AMARA, { choices: ['reaction'], reactionText: REACTION })

    expect(await sourcesOf('profile-amara-1')).toEqual(['skin-log', 'reaction'])
  })

  it('does not carry a mark to another profile\'s save', async () => {
    await set(AMARA, { choices: ['none'] })
    await set(TOLU, { choices: ['none'] })
    await set(AMARA_SECOND_PROFILE, { choices: ['none'] })
    await service.markReactionProduct('profile-amara-1', NIGHT)
    tick()

    await set(TOLU, { choices: ['pregnant'] })
    await set(AMARA_SECOND_PROFILE, { choices: ['pregnant'] })

    expect(await skinLogOf('profile-tolu-1')).toEqual([])
    expect(await skinLogOf('profile-amara-2')).toEqual([])
    expect(await skinLogOf('profile-amara-1')).toHaveLength(1)
  })

  it('does not carry a reaction or a prescription mention: they are read again from the new words', async () => {
    await parsedAnswer(AMARA, { choices: ['reaction', 'prescription'], reactionText: REACTION, prescriptionText: PRESCRIPTION })
    expect(await sourcesOf('profile-amara-1')).toEqual(['reaction', 'prescription'])
    tick()

    await set(AMARA, { choices: ['reaction', 'prescription'], reactionText: REACTION, prescriptionText: PRESCRIPTION })

    // Saved but not yet parsed: the new row holds no mention of them.
    expect(await mentionsOf('profile-amara-1')).toEqual([])
  })

  it('carries the mark and drops the reaction and prescription mentions in the same save', async () => {
    await parsedAnswer(AMARA, { choices: ['reaction', 'prescription'], reactionText: REACTION, prescriptionText: PRESCRIPTION })
    await service.markReactionProduct('profile-amara-1', NIGHT)
    tick()

    await set(AMARA, { choices: ['none'] })

    expect(await sourcesOf('profile-amara-1')).toEqual(['skin-log'])
  })

  it('leaves a first save, with nothing before it, with no mentions', async () => {
    await set(AMARA, { choices: ['pregnant'] })

    expect(await mentionsOf('profile-amara-1')).toEqual([])
  })

  it('does not save the carried mark when the save is refused', async () => {
    await set(AMARA, { choices: ['none'] })
    await service.markReactionProduct('profile-amara-1', NIGHT)

    await expect(set(AMARA, { choices: ['none', 'pregnant'] })).rejects.toThrow()

    expect(await repository.history('profile-amara-1')).toHaveLength(1)
    expect(await skinLogOf('profile-amara-1')).toHaveLength(1)
  })
})

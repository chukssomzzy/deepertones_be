import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../../src/index'
import { buildContainer } from '../../src/container'
import { runAs } from '../../src/lib/context'
import { createDb } from '../../src/lib/db'
import type { RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { SafetyChoice } from '../../src/modules/safety/safety.vocabulary'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { applyCatalogChange, availabilityRow, countryRow, productRow, putCountry, type RawWorkbook } from './catalog.workbook.support'

// candidatesFor end to end: the recommendation catalog is loaded the way the team loads it (the admin import, PR 3, so these tests are red until
// PR 3 is merged in), a user gets a goal, safety answers and a shopping country through the services, as the routes do, and the answer is read
// from the container's service as the routine stage will read it. No part of the chain is a fake: the Worker's D1, the live ingredient rules
// seeded by the migration, the import's exact join to the catalog, the real goal, safety and shopping history. There is no face scan, so the user's
// skin type is unknown, and no reaction words, because parsing them calls a model (the unit tests drive those rules).

const quietQueue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue
const WORKER_ENV = { ...env, PARSE_SAFETY_QUEUE: quietQueue, SCAN_ITEMS_QUEUE: quietQueue, PUSH_DELIVERY_QUEUE: quietQueue }
const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())
const container = buildContainer(WORKER_ENV)
const users = new D1UsersRepository(createDb(env.DB))

// The database is shared by the whole file, so every code and brand is one no other test has.
const salt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
const code = (suffix: string) => `E2E-${salt}-${suffix}`
const BRAND = `${salt}x E2E Brand`

type Seed = { suffix: string; name: string; country?: string; price: number; over?: Record<string, string | number | null> }
// NG's low band is up to 5000 and its mid band up to 15000 (see the Countries row below). The goal used is glow: hd_radiance, hd_moisture, hd_texture.
const SEEDS: Seed[] = [
  { suffix: 'CHEAP', name: 'Cheap Cream', price: 1000 },
  { suffix: 'BRAND', name: 'Brand Paid Cream', price: 1200, over: { origin: 'brand-submitted' } },
  // Seeded rule: retinol carries a pregnancy caution. The row says nothing of it in its own cautions.
  { suffix: 'RETINOL', name: 'Retinol Cream', price: 1500, over: { ingredients: 'Aqua; Retinol; Glycerin' } },
  { suffix: 'PLAIN', name: 'Plain Cream', price: 2500 },
  { suffix: 'PRICEY', name: 'Pricey Cream', price: 5001 },
  { suffix: 'ACNE-ONLY', name: 'Spot Cream', price: 900, over: { skin_concerns: 'hd_acne' } },
  { suffix: 'OILY-ONLY', name: 'Oily Skin Cream', price: 900, over: { skin_types: 'oily' } },
  { suffix: 'CLEANSER', name: 'Gentle Cleanser', price: 800, over: { steps: 'cleanse' } },
  // A draft row is work in progress: it is never recommended.
  { suffix: 'DRAFT', name: 'Draft Cream', price: 700, over: { status: 'draft', approved_by: null, approved_on: null } },
  { suffix: 'GH-ONLY', name: 'Accra Cream', country: 'GH', price: 40 },
]

const load = (workbook: RawWorkbook) => {
  putCountry(workbook, countryRow('NG'))
  putCountry(workbook, countryRow('GH', { currency: 'GHS', low_max: 100, mid_max: 300 }))
  for (const seed of SEEDS) {
    workbook.products.rows.push(productRow({ code: code(seed.suffix), brand: BRAND, name: seed.name, ...seed.over }))
    workbook.availability.rows.push(availabilityRow(code(seed.suffix), seed.country ?? 'NG', seed.price))
  }
}

beforeAll(async () => {
  await applyCatalogChange(fetchWorker, load)
})

/** A new guest, with the goal, safety answers and shopping fact a test is about; resolves to a way to ask as them. */
const userWith = async (over: { choices?: SafetyChoice[]; country?: string; band?: string } = {}) => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: new Date() }, device: { deviceHash: `candidates-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  const asUser = <T>(fn: () => Promise<T>) => runAs({ kind: 'user', userId, status: 'anonymous', profileId }, fn)
  await asUser(() => container.goals.set({ goal: 'glow' }))
  await asUser(() => container.safety.set({ choices: over.choices ?? ['none'] }))
  await asUser(() => container.recommendations.setShopping({ country: over.country ?? 'NG', ...(over.band === undefined ? {} : { budgetBand: over.band }) }))
  return { asUser, candidates: (step: RoutineStep = 'moisturise') => asUser(() => container.recommendations.candidatesFor({ step })) }
}
const codesOf = (candidates: { code: string }[]) => candidates.map((candidate) => candidate.code)

describe('RecommendationService.candidatesFor against a loaded recommendation catalog', () => {
  it('lists, cheapest first, the approved rows sold in the user\'s country that fill the step, work on the goal and suit an unknown skin type', async () => {
    const amara = await userWith()

    expect(codesOf(await amara.candidates())).toEqual([code('CHEAP'), code('BRAND'), code('RETINOL'), code('PLAIN'), code('PRICEY')])
  })

  it('names each candidate\'s product as the catalog knows it, and shows its origin without letting it change the place', async () => {
    const amara = await userWith()

    const candidates = await amara.candidates()

    expect(candidates.find((candidate) => candidate.code === code('BRAND'))).toMatchObject({
      origin: 'brand-submitted',
      product: { brand: BRAND, name: 'Brand Paid Cream', category: 'skin' },
      priceMin: 1200,
    })
    expect(candidates.find((candidate) => candidate.code === code('CHEAP'))).toMatchObject({ origin: 'sourced', product: { brand: BRAND, name: 'Cheap Cream' } })
  })

  it('leaves out the row whose ingredients carry a pregnancy caution for a pregnant user, though the row itself claims nothing', async () => {
    const pregnant = await userWith({ choices: ['pregnant'] })
    const breastfeeding = await userWith({ choices: ['breastfeeding'] })

    expect(codesOf(await pregnant.candidates())).toEqual([code('CHEAP'), code('BRAND'), code('PLAIN'), code('PRICEY')])
    expect(codesOf(await breastfeeding.candidates())).toEqual([code('CHEAP'), code('BRAND'), code('PLAIN'), code('PRICEY')])
  })

  it('applies the budget band with the country\'s own thresholds: low is up to 5000, so a lowest price of 5001 is out of it, and mid (up to 15000) lets it in', async () => {
    const tolu = await userWith({ band: 'low' })
    const chidi = await userWith({ band: 'mid' })

    expect(codesOf(await tolu.candidates())).toEqual([code('CHEAP'), code('BRAND'), code('RETINOL'), code('PLAIN')])
    expect(codesOf(await chidi.candidates())).toEqual([code('CHEAP'), code('BRAND'), code('RETINOL'), code('PLAIN'), code('PRICEY')])
  })

  it('answers for the step asked about: a cleanser is a candidate for the cleanse step only', async () => {
    const amara = await userWith()

    expect(codesOf(await amara.candidates('cleanse'))).toEqual([code('CLEANSER')])
    expect(await amara.candidates('protect')).toEqual([])
  })

  it('answers for the shopping country: a row sold only in Ghana is a candidate in Ghana and not in Nigeria', async () => {
    const kofi = await userWith({ country: 'GH' })
    const amara = await userWith({ country: 'NG' })

    expect(codesOf(await kofi.candidates())).toEqual([code('GH-ONLY')])
    expect(codesOf(await amara.candidates())).not.toContain(code('GH-ONLY'))
  })

  it('never recommends a draft row, whatever else it passes', async () => {
    const amara = await userWith()

    expect(codesOf(await amara.candidates())).not.toContain(code('DRAFT'))
  })

  it('answers an empty list, not an error, once the user\'s country is retired by a later upload', async () => {
    const kofi = await userWith({ country: 'GH' })
    expect(codesOf(await kofi.candidates())).toEqual([code('GH-ONLY')])

    await applyCatalogChange(fetchWorker, (workbook) => putCountry(workbook, countryRow('GH', { currency: 'GHS', low_max: 100, mid_max: 300, status: 'retired' })))

    expect(await kofi.candidates()).toEqual([])
  })
})

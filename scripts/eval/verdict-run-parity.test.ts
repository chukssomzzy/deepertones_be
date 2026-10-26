import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryVerdictFitter } from '../../src/providers/verdict-fitting/memory.verdict-fitter'
import type { FitRequest, FitResult } from '../../src/providers/verdict-fitting/verdict-fitter.provider'
import { FakeVerdictsRepository } from '../../src/modules/verdicts/verdicts.repository.fake'
import { VerdictService } from '../../src/modules/verdicts/verdicts.service'
import type { VerdictCase } from './verdict-cases'
import { factsOf } from './verdict-facts'
import { harness, helpingAll, openIds } from './verdict-run.fixture'
import { BASE, FIXTURE, FIXTURE_REFERENCE } from './verdict.fixture'

// The eval's verdict must be the app's verdict. The harness (verdict-run.ts) repeats the sequence of VerdictService.build (factsOf, assembleVerdictInputs,
// floorVerdicts, fitRequestOf, the judge, mergeVerdict, and the floor-only merge when the judge fails); a harness that forgot a step, passed the merge the wrong
// safety choices, or merged differently would measure a verdict nobody gets. So here the SAME case, the SAME fit answer, goes through both: the real VerdictService
// over small fakes (as verdicts.service.test.ts builds them, only fed from the case's own facts) and the harness; the products that come out must be equal.
//
// Wiring the service takes one fake per accessor, each answering from `factsOf(case)`: practical, so the parity is pinned for real and not just the sequence.
// What the service saves besides the merge (each product's routine step and the sources of its rules) is not the merge's, so it is stripped before comparing.

afterEach(() => {
  vi.restoreAllMocks()
})

const PROFILE = 'profile-parity'

const serviceFor = (c: VerdictCase, fitter: MemoryVerdictFitter) => {
  const facts = factsOf(c, FIXTURE_REFERENCE, fitter.identity)
  const repository = new FakeVerdictsRepository()
  const service = new VerdictService({
    repository,
    fitter,
    jobs: new MemoryJobQueue(),
    workbook: { verdictReference: async () => FIXTURE_REFERENCE, tapersByCode: async () => new Map(), stepsFor: async () => facts.steps, skinConcernsFor: async () => facts.skinConcerns },
    catalog: { shelfFacts: async () => facts.shelfFacts, latestIngredients: async (productId: string) => facts.mentionIngredients.get(productId) ?? null },
    shelf: { activeEntriesFor: async () => facts.entries },
    scans: { noLabelFacts: async () => facts.noLabelFacts, hasShelfWorkInFlight: async () => false },
    safety: { snapshotFor: async () => facts.safety },
    goals: { goalFor: async () => facts.goal },
    faceScans: { latestConcernLevelsFor: async () => facts.scan },
    now: () => BASE,
  } as never)
  return { repository, service }
}

/** What the real service saves for the case when the judge answers `answer`: its products without the two things the merge does not decide. */
const savedByService = async (c: VerdictCase, answer: (request: FitRequest) => FitResult, failure?: Error) => {
  const fitter = new MemoryVerdictFitter()
  fitter.respondWith(answer)
  if (failure) fitter.failNextWith(failure)
  const { repository, service } = serviceFor(c, fitter)
  // A build is claimed before it runs, as it is in life (current() claims it).
  await repository.requestBuild(PROFILE, 'claimed', BASE, new Date(0))
  const built = service.build({ profileId: PROFILE, fingerprint: 'claimed', requestedAt: BASE.getTime(), waits: 0 })
  // A failed judge is saved first and then thrown for the queue to retry; the save is what is compared.
  if (failure) await built.catch(() => undefined)
  else await built
  const row = (await repository.find(PROFILE))!
  return row.products.map(({ step: _step, sourceUrls: _sourceUrls, ...merged }) => merged)
}

const namingRetinol = (request: FitRequest): FitResult => ({ ...helpingAll(request), clashes: request.clashes.map(({ ids }) => ({ ids, reduceId: 'retinol-serum' })) })
const acidRedundant = (request: FitRequest): FitResult => ({
  products: openIds(request).map((id) => (id === 'acid-toner' ? { id, label: 'redundant' as const, reason: 'Does what the serum does.', sameJobAs: 'retinol-serum' } : { id, label: 'helping' as const, reason: 'Suits the goal.', sameJobAs: null })),
  clashes: [],
})
const blockingAll = (request: FitRequest): FitResult => ({ products: openIds(request).map((id) => ({ id, label: 'blocking' as const, reason: 'Holds the goal back.', sameJobAs: null })), clashes: [] })

// A stopped steroid for a person who ticked prescription: the reason carries the prescriber's note only when the merge is given the safety choices.
const prescribedChoice: VerdictCase = { ...FIXTURE.steroid, id: 'main-30', safety: { choices: ['prescription'], mentions: [] } }

describe('the eval harness gives the products VerdictService.build saves, for the same fit answer', () => {
  it.each([
    ['a floor-decided product beside an open one the judge calls helping', FIXTURE.reactionProduct, helpingAll],
    ['an open product the judge calls blocking', FIXTURE.reactionIngredient, blockingAll],
    ['a clash the judge settles, which reduces the product it names', FIXTURE.retinoidAcidClash, namingRetinol],
    ['a clash left to the floor\'s tie-break, with a redundant product that stays dropped', FIXTURE.retinoidAcidClash, acidRedundant],
    ['a stopped steroid worded for a person who ticked prescription (the merge is given the safety choices)', prescribedChoice, helpingAll],
    ['a shelf the floor settled whole, so no judge is asked', FIXTURE.mercury, helpingAll],
    ['a pregnant person\'s retinol, set aside by the floor', FIXTURE.pregnancyRetinol, helpingAll],
  ])('%s', async (_what, c, answer) => {
    const { run } = harness({ cases: [c], answer: (_call, request) => answer(request) })

    const { report } = await run()

    expect(report.cases[0]!.products).toEqual(await savedByService(c, answer))
  })

  it('leaves the open products undecided when the judge fails, as the service saves them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('the fit judge is unavailable')
    const { run, inner } = harness({ cases: [FIXTURE.reactionProduct] })
    inner.failNextWith(failure)

    const { report } = await run()

    expect(report.cases[0]!.state).toBe('fit-error')
    expect(report.cases[0]!.products).toEqual(await savedByService(FIXTURE.reactionProduct, helpingAll, failure))
  })
})

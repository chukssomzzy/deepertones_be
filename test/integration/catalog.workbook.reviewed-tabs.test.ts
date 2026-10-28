import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { buildContainer } from '../../src/container'
import { createDb } from '../../src/lib/db'
import { D1CatalogWorkbookRepository, type WorkbookPlan } from '../../src/modules/catalog/catalog.workbook.repository'
import { CONTRACT_VERSION } from '../../src/modules/catalog/catalog.workbook.schema'
import {
  OUTCOMES,
  REASONS,
  WORKER_ENV,
  allEscalationRows,
  allResponseRows,
  applied,
  baseReintroductionRows,
  baseWeekRows,
  reintroductionRow,
  responseRow,
  weekRow,
} from './admin.catalog.support'

// The four reads of contract 2.3.0 (reintroductionFor, escalationFor, responseFor, weekCardFor) against real local D1, wired as the Worker wires them. The rows get there the way
// the team's do, through the admin import (export, edit, upload), and are read back through the service. What the import accepts, and the diff it reports, is in
// admin.catalog.import.test.ts; the unit tier has the same behaviour over the fake repository (catalog.workbook.service.test.ts).
// The database is shared by the whole file, so a test writes the whole of the tabs it reads. The first test runs before any row is written.

const workbook = () => buildContainer(WORKER_ENV).catalogWorkbook

describe('the reads on a database where nobody has written the reviewed tabs', () => {
  it('give nothing: an empty ladder and null, since there is nothing approved to give', async () => {
    expect(await workbook().reintroductionFor(null)).toEqual([])
    expect(await workbook().reintroductionFor('retinoid')).toEqual([])
    expect(await workbook().escalationFor('swelling')).toBeNull()
    expect(await workbook().responseFor('paused')).toBeNull()
    expect(await workbook().weekCardFor(1, 'glow', false)).toBeNull()
    expect(await workbook().weekCardFor(20, 'glow', true)).toBeNull()
  })
})

describe('reintroductionFor after the team has written ladders', () => {
  const defaultLadder = reintroductionRow({ schedule: '1: weekly; 2: back' })
  const retinoid = reintroductionRow({ group: 'retinoid', schedule: '1-2: as-needed; 3-4: weekly; 5: am; 6: back' })
  const setLadders = (...rows: ReturnType<typeof reintroductionRow>[]) => applied((w) => (w.reintroductions.rows = [defaultLadder, ...rows]))
  const DEFAULT_STEPS = [{ fromWeek: 1, toWeek: 1, frequency: 'weekly' }, { fromWeek: 2, toWeek: 2, frequency: 'back' }]

  it('gives the steps of the ladder of the group, as the schedule reads', async () => {
    await setLadders(retinoid)

    expect(await workbook().reintroductionFor('retinoid')).toEqual([
      { fromWeek: 1, toWeek: 2, frequency: 'as-needed' },
      { fromWeek: 3, toWeek: 4, frequency: 'weekly' },
      { fromWeek: 5, toWeek: 5, frequency: 'am' },
      { fromWeek: 6, toWeek: 6, frequency: 'back' },
    ])
  })

  it('gives the default ladder for no group, and for a group with no ladder of its own', async () => {
    await setLadders(retinoid)

    expect(await workbook().reintroductionFor(null)).toEqual(DEFAULT_STEPS)
    expect(await workbook().reintroductionFor('exfoliating-acid')).toEqual(DEFAULT_STEPS)
  })

  it('gives the default ladder for a group whose ladder is a draft, and for one that has been retired', async () => {
    await setLadders(reintroductionRow({ group: 'exfoliating-acid', schedule: '1: as-needed; 2: back' }), reintroductionRow({ group: 'benzoyl-peroxide', schedule: '1: as-needed; 2: back' }))
    await setLadders(reintroductionRow({ group: 'exfoliating-acid', schedule: '1: as-needed; 2: back', status: 'draft', approved_by: null, approved_on: null }))

    expect(await workbook().reintroductionFor('exfoliating-acid')).toEqual(DEFAULT_STEPS)
    expect(await workbook().reintroductionFor('benzoyl-peroxide')).toEqual(DEFAULT_STEPS)
  })

  it('reads what is live now: a changed default ladder and a changed group ladder are given as changed after the upload', async () => {
    await setLadders(retinoid)
    expect(await workbook().reintroductionFor('retinoid')).toHaveLength(4)

    await applied((w) => {
      w.reintroductions.rows.find((row) => row.group === 'retinoid')!.schedule = '1: weekly; 2: back'
      w.reintroductions.rows.find((row) => row.group === null)!.schedule = '1: as-needed; 2: back'
    })

    expect(await workbook().reintroductionFor('retinoid')).toEqual(DEFAULT_STEPS)
    expect(await workbook().reintroductionFor(null)).toEqual([{ fromWeek: 1, toWeek: 1, frequency: 'as-needed' }, { fromWeek: 2, toWeek: 2, frequency: 'back' }])
  })
})

describe('escalationFor after the team has written escalations', () => {
  it('gives the three texts of the reason and nothing else, and the row of its own reason for each', async () => {
    await applied((w) => (w.escalations.rows = allEscalationRows()))

    expect(await workbook().escalationFor('swelling')).toEqual({ whoToSee: 'Who to see for swelling.', howSoon: 'How soon for swelling.', whatToTellThem: 'What to tell them for swelling.' })
    for (const reason of REASONS) expect(await workbook().escalationFor(reason), reason).toMatchObject({ whoToSee: `Who to see for ${reason}.` })
  })

  it('reads what is live now: a changed text is given as changed after the upload', async () => {
    await applied((w) => (w.escalations.rows = allEscalationRows()))

    await applied((w) => {
      w.escalations.rows.find((row) => row.reason === 'near-eyes')!.how_soon = 'The same day.'
    })

    expect(await workbook().escalationFor('near-eyes')).toMatchObject({ howSoon: 'The same day.' })
    expect(await workbook().escalationFor('swelling')).toMatchObject({ howSoon: 'How soon for swelling.' })
  })
})

describe('responseFor after the team has written responses', () => {
  it('gives the title, body and what to do now of the outcome, with {step} left in for the server to fill, and the row of its own outcome for each', async () => {
    await applied((w) => (w.responses.rows = allResponseRows().map((row) => (row.outcome === 'paused' ? responseRow({ outcome: 'paused', title: 'We paused your {step}', body: 'A rest for your {step}.', what_to_do_now: 'Skip anything that stings.' }) : row))))

    expect(await workbook().responseFor('paused')).toEqual({ title: 'We paused your {step}', body: 'A rest for your {step}.', whatToDoNow: 'Skip anything that stings.' })
    for (const outcome of OUTCOMES.filter((one) => one !== 'paused')) expect(await workbook().responseFor(outcome), outcome).toEqual({ title: `Title for ${outcome}`, body: `Body for ${outcome}.`, whatToDoNow: `What to do for ${outcome}.` })
  })

  it('gives whatToDoNow as null when the row has none', async () => {
    await applied((w) => (w.responses.rows = allResponseRows().map((row) => (row.outcome === 'check-calmer' ? { ...row, what_to_do_now: null } : row))))

    expect(await workbook().responseFor('check-calmer')).toEqual({ title: 'Title for check-calmer', body: 'Body for check-calmer.', whatToDoNow: null })
  })

  it('reads what is live now: a changed text is given as changed after the upload', async () => {
    await applied((w) => (w.responses.rows = allResponseRows()))

    await applied((w) => {
      w.responses.rows.find((row) => row.outcome === 'check-worse')!.body = 'A newer body.'
    })

    expect(await workbook().responseFor('check-worse')).toMatchObject({ body: 'A newer body.' })
  })
})

describe('weekCardFor after the team has written week cards', () => {
  // Four cards for band 3-4, each saying which of the four it is, so a test can tell which one it was given.
  const both = weekRow({ band: '3-4', goal: 'glow', step_down: 'yes', title: 'Goal and step-down', text: 'Goal and step-down text.' })
  const stepDownOnly = weekRow({ band: '3-4', step_down: 'yes', title: 'Step-down only', text: 'Step-down only text.' })
  const goalOnly = weekRow({ band: '3-4', goal: 'glow', title: 'Goal only', text: 'Goal only text.' })
  const setWeeks = (...extra: ReturnType<typeof weekRow>[]) => applied((w) => (w.weeks.rows = [...baseWeekRows(), ...extra]))

  it('gives the title and text and nothing else', async () => {
    await setWeeks()

    expect(await workbook().weekCardFor(1, 'glow', false)).toEqual({ title: 'Title for 1', text: 'Text for 1.' })
  })

  it.each([
    [1, '1'], [2, '2'], [3, '3-4'], [4, '3-4'], [5, '5-8'], [8, '5-8'], [9, '9-12'], [12, '9-12'], [13, '9-12'], [52, '9-12'],
  ] as const)('maps week %i to band %s: the bands end at weeks 1, 2, 4, 8 and 12, and week 13 and later use the last', async (week, band) => {
    await setWeeks()

    expect(await workbook().weekCardFor(week, 'glow', false)).toEqual({ title: `Title for ${band}`, text: `Text for ${band}.` })
  })

  it('gives the first approved match: goal and step-down, then step-down, then goal, then the base card', async () => {
    await setWeeks(both, stepDownOnly, goalOnly)

    expect(await workbook().weekCardFor(3, 'glow', true)).toEqual({ title: 'Goal and step-down', text: 'Goal and step-down text.' })
    expect(await workbook().weekCardFor(3, 'even-tone', true)).toEqual({ title: 'Step-down only', text: 'Step-down only text.' })
    expect(await workbook().weekCardFor(3, 'glow', false)).toEqual({ title: 'Goal only', text: 'Goal only text.' })
    expect(await workbook().weekCardFor(3, 'even-tone', false)).toEqual({ title: 'Title for 3-4', text: 'Text for 3-4.' })
  })

  it('prefers the step-down card with no goal to the goal card without a step-down, and falls to the goal card when there is no step-down card', async () => {
    await setWeeks(stepDownOnly, goalOnly)
    expect(await workbook().weekCardFor(3, 'glow', true)).toEqual({ title: 'Step-down only', text: 'Step-down only text.' })

    await setWeeks(goalOnly)
    expect(await workbook().weekCardFor(3, 'glow', true)).toEqual({ title: 'Goal only', text: 'Goal only text.' })
  })

  it('ignores a card that is a draft, and one that has been retired, and gives the next match', async () => {
    await setWeeks(
      weekRow({ band: '3-4', goal: 'glow', title: 'Draft', text: 'Draft text.', status: 'draft', approved_by: null, approved_on: null }),
      weekRow({ band: '3-4', goal: 'even-tone', title: 'Retired later', text: 'Retired later text.' }),
    )
    await applied((w) => (w.weeks.rows = w.weeks.rows.filter((row) => row.goal !== 'even-tone')))

    expect(await workbook().weekCardFor(3, 'glow', false)).toEqual({ title: 'Title for 3-4', text: 'Text for 3-4.' })
    expect(await workbook().weekCardFor(3, 'even-tone', false)).toEqual({ title: 'Title for 3-4', text: 'Text for 3-4.' })
  })

  it('reads what is live now: a changed card is given as changed after the upload', async () => {
    await setWeeks(goalOnly)

    await applied((w) => {
      w.weeks.rows.find((row) => row.goal === 'glow' && row.band === '3-4')!.text = 'Newer goal text.'
    })

    expect(await workbook().weekCardFor(4, 'glow', false)).toEqual({ title: 'Goal only', text: 'Newer goal text.' })
  })
})

// A draft or a retired escalation or response cannot be uploaded (the contract refuses the upload that would leave its reason or outcome without an approved row), so the only
// way to see that the reads leave one alone is to write it to the store directly, through the same plan an upload is applied with.
describe('a read never gives an escalation or a response that is not approved', () => {
  const repo = new D1CatalogWorkbookRepository(createDb(env.DB))
  const planOf = async (over: Partial<WorkbookPlan>): Promise<WorkbookPlan> => ({
    baseVersion: await repo.catalogVersion(),
    rulesVersion: (await repo.liveRules()).version,
    contractVersion: CONTRACT_VERSION,
    uploadedBy: 'reviewed tabs test',
    archiveKey: `workbooks/test/reviewed-${crypto.randomUUID()}.xlsx`,
    now: new Date('2030-06-15T10:00:00.000Z'),
    newProducts: [],
    products: [],
    availability: null,
    ingredients: [],
    countries: [],
    retiredProducts: [],
    retiredIngredients: [],
    retiredCountries: [],
    claimWords: [],
    tapers: [],
    retiredClaimWords: [],
    retiredTapers: [],
    guides: [],
    retiredGuides: [],
    reintroductions: [],
    retiredReintroductions: [],
    escalations: [],
    retiredEscalations: [],
    responses: [],
    retiredResponses: [],
    weeks: [],
    retiredWeeks: [],
    ...over,
  })
  const unapproved = { approvedBy: null, approvedOn: null, auditedBy: null, auditedOn: null }

  it.each(['draft', 'retired'] as const)('gives null for the escalation of a reason whose only row is %s', async (status) => {
    expect(await repo.applyWorkbook(await planOf({ escalations: [{ reason: 'unchanged-after-checks', whoToSee: 'A', howSoon: 'B', whatToTellThem: 'C', status, ...unapproved }] }))).toBe(true)

    expect(await workbook().escalationFor('unchanged-after-checks')).toBeNull()
  })

  it.each(['draft', 'retired'] as const)('gives null for the response of an outcome whose only row is %s', async (status) => {
    expect(await repo.applyWorkbook(await planOf({ responses: [{ outcome: 'check-same', title: 'A', body: 'B', whatToDoNow: null, status, ...unapproved }] }))).toBe(true)

    expect(await workbook().responseFor('check-same')).toBeNull()
  })

  it('gives an approved escalation written the same way, so the null above is the status and not the route', async () => {
    expect(
      await repo.applyWorkbook(
        await planOf({ escalations: [{ reason: 'harm-while-two-paused', whoToSee: 'A doctor.', howSoon: 'Today.', whatToTellThem: 'What you noticed.', status: 'approved', approvedBy: 'Dr A. Reviewer', approvedOn: new Date('2030-06-15T00:00:00.000Z'), auditedBy: null, auditedOn: null }] }),
      ),
    ).toBe(true)

    expect(await workbook().escalationFor('harm-while-two-paused')).toEqual({ whoToSee: 'A doctor.', howSoon: 'Today.', whatToTellThem: 'What you noticed.' })
  })
})

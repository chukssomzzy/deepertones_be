import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { MemoryEmailSender } from '../../providers/email/memory.email'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { FakeOpsAlertsRepository } from '../ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import { sendOpsAlertSpec } from '../ops-alerts/ops-alerts.job-specs'
import { FakeVerdictReportsRepository } from './verdicts.reports.repository.fake'
import { VerdictReportsService } from './verdicts.reports.service'
import type { SavedVerdictView } from './verdicts.service'
import type { SavedVerdictProduct } from './verdicts.types'

// "Report a mistake" (spec #259, PR B1): the service behind POST /me/verdict/products/{entryId}/reports.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the behaviour, not the names):
//   new VerdictReportsService({ repository, verdicts, opsAlerts, now })
//     repository  a VerdictReportsRepository (the fake here)
//     verdicts    Pick<VerdictService, 'savedFor'>: the verdict the person would be served right now, by profile id. `savedFor` answers null for a verdict that is pending, stale
//                 (built from inputs that have changed) or gated, so a report can never be made against a verdict the person is not being shown.
//     opsAlerts   Pick<OpsAlertsService, 'raise'>
//   reportMistake(entryId: string, note?: string | null): Promise<{ id: string; created: boolean }>
//     The checks run in this order and nothing is stored or raised until all pass:
//       1. a session (401 AUTH_REQUIRED), 2. a verified account (403 SIGNUP_REQUIRED; a guest is turned away before the note is looked at),
//       3. the note: trimmed, at most 500 characters after trimming, empty or whitespace becomes null (400 VALIDATION_FAILED over 500),
//       4. the entry is a product of the served verdict (404 VERDICT_PRODUCT_NOT_FOUND: no entry like it, or no served verdict at all).
//     It then stores a `mistake` report with the product's group and verdict action as saved, the verdict's fingerprint, basis null and the note, through the repository's upsertMistake
//     (the id is made by the service, a UUID). `created` is the repository's: true for a new report, false when it updated the one for the same entry and verdict.
//     The alert `opsAlerts.raise('verdict-report')` is raised only when a row was created. A report never changes the verdict.
//     The note is never logged, never in an error, an alert or a job message. A failure logs ids only (or nothing).

const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)
const MARKER = 'QZ-PRIVATE-NOTE-7731'

const actor = (userId: string, profileId: string, status: 'anonymous' | 'verified' = 'verified'): Actor => ({ kind: 'user', userId, status, profileId })
const AMARA = actor('user-amara', 'profile-amara-1')
const TOLU = actor('user-tolu', 'profile-tolu-1')
const NGOZI = actor('user-ngozi', 'profile-ngozi-1', 'anonymous')
const PUBLIC: Actor = { kind: 'public' }

const FINGERPRINT = 'f'.repeat(64)
const REBUILT_FINGERPRINT = 'e'.repeat(64)

const products = (): SavedVerdictProduct[] => [
  { entryId: 'entry-a', group: 'helping', verdict: { kind: 'keep' }, escalate: false, reason: 'Niacinamide works on dark marks.', facts: [], step: 'treat', sourceUrls: [] },
  {
    entryId: 'entry-b',
    group: 'likely-the-problem',
    verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' },
    escalate: false,
    reason: 'Holds a steroid, which is stopped step by step.',
    facts: [{ kind: 'ingredient-group', group: 'steroid', ingredient: 'Clobetasol Propionate', ruleName: 'clobetasol propionate' }],
    step: null,
    sourceUrls: ['https://example.org/rules/clobetasol'],
  },
  { entryId: 'entry-c', group: 'conflicting', verdict: { kind: 'reduce', maxFrequency: 'alternate-days' }, escalate: false, reason: 'Clashes with the acid.', facts: [], step: 'treat', sourceUrls: [] },
]

const savedView = (over: Partial<SavedVerdictView> = {}): SavedVerdictView => ({ fingerprint: FINGERPRINT, fit: 'ready', builtAt: at(-HOUR), rulesVersion: 'rules-v1', products: products(), ...over })

let clock: Date
let saved: SavedVerdictView | null
let savedForCalls: string[]
let savedForFails: Error | null
let repository: FakeVerdictReportsRepository
let upsertCalls: number
let jobs: MemoryJobQueue
let email: MemoryEmailSender
let opsAlerts: OpsAlertsService
let service: VerdictReportsService

/** A repository that counts what it was asked to write and can be told to fail. */
class WatchedReports extends FakeVerdictReportsRepository {
  fails: Error | null = null
  override async upsertMistake(...args: Parameters<FakeVerdictReportsRepository['upsertMistake']>) {
    upsertCalls++
    if (this.fails) throw this.fails
    return super.upsertMistake(...args)
  }
}

const report = (entryId: string, note?: string | null, who: Actor = AMARA) => runAs(who, () => service.reportMistake(entryId, note))
const setClock = (offsetMs: number) => {
  clock = at(offsetMs)
}
const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}
const alertsQueued = () => jobs.enqueued.filter((job) => job.job === 'send-ops-alert').map((job) => (job.body as { kind: string }).kind)

const spyOnConsole = () => (['log', 'debug', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
const loggedBy = (spies: ReturnType<typeof spyOnConsole>) => spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call)))

beforeEach(() => {
  clock = T0
  saved = savedView()
  savedForCalls = []
  savedForFails = null
  upsertCalls = 0
  const watched = new WatchedReports()
  repository = watched
  jobs = new MemoryJobQueue()
  email = new MemoryEmailSender()
  opsAlerts = new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs, email, recipient: 'ops@example.com', environment: 'staging', now: () => clock })
  service = new VerdictReportsService({
    repository,
    verdicts: {
      savedFor: async (profileId: string) => {
        savedForCalls.push(profileId)
        if (savedForFails) throw savedForFails
        return saved && structuredClone(saved)
      },
    },
    opsAlerts,
    now: () => clock,
  })
})

afterEach(() => vi.restoreAllMocks())

describe('VerdictReportsService.reportMistake: reporting a product of the verdict', () => {
  it('stores a mistake report with the product\'s group and verdict as saved, the verdict\'s fingerprint, no basis and the note, and answers its id as created', async () => {
    const answer = await report('entry-b', 'This is not a steroid cream')

    expect(answer).toEqual({ id: expect.any(String), created: true })
    expect(await repository.find(answer.id)).toEqual({
      id: answer.id,
      profileId: 'profile-amara-1',
      entryId: 'entry-b',
      kind: 'mistake',
      group: 'likely-the-problem',
      verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' },
      basis: null,
      fingerprint: FINGERPRINT,
      note: 'This is not a steroid cream',
      oldProductId: null,
      newProductId: null,
      createdAt: T0,
      updatedAt: T0,
    })
  })

  it.each([
    ['entry-a', 'helping', { kind: 'keep' }],
    ['entry-c', 'conflicting', { kind: 'reduce', maxFrequency: 'alternate-days' }],
  ])('reports %s with its own group %s and its own verdict', async (entryId, group, verdict) => {
    const answer = await report(entryId, null)

    expect(await repository.find(answer.id)).toMatchObject({ entryId, group, verdict })
  })

  it('reads the verdict of the session\'s own profile', async () => {
    await report('entry-a', null, TOLU)

    expect(savedForCalls).toEqual(['profile-tolu-1'])
  })

  it('stores a report with no note, with the note null', async () => {
    const answer = await report('entry-a')

    expect(await repository.find(answer.id)).toMatchObject({ note: null })
  })

  it('raises the verdict-report alert once for a new report', async () => {
    await report('entry-a', 'a note')

    expect(alertsQueued()).toEqual(['verdict-report'])
  })
})

describe('VerdictReportsService.reportMistake: reporting the same product and verdict again', () => {
  it('updates the first report: the same id, created false, the note and the updated time replaced and the creation time kept', async () => {
    const first = await report('entry-a', 'first thoughts')
    setClock(5 * MINUTE)

    const again = await report('entry-a', 'second thoughts')

    expect(again).toEqual({ id: first.id, created: false })
    expect(await repository.find(first.id)).toMatchObject({ note: 'second thoughts', createdAt: T0, updatedAt: at(5 * MINUTE) })
  })

  it('raises no second alert, even a day later when the window has changed', async () => {
    await report('entry-a', 'first')
    setClock(DAY + MINUTE)

    await report('entry-a', 'second')

    expect(alertsQueued()).toEqual(['verdict-report'])
  })

  it('treats two reports made at once as one new report and one update, with one alert', async () => {
    const answers = await Promise.all([report('entry-a', 'one'), report('entry-a', 'two')])

    expect(answers.filter((answer) => answer.created)).toHaveLength(1)
    expect(answers[1]!.id).toBe(answers[0]!.id)
    expect(alertsQueued()).toEqual(['verdict-report'])
  })

  it('takes a report of another product of the same verdict as a new report with its own id', async () => {
    const first = await report('entry-a', null)

    const second = await report('entry-b', null)

    expect(second.created).toBe(true)
    expect(second.id).not.toBe(first.id)
  })

  it('takes a report after the verdict has been rebuilt (another fingerprint) as a new report, and keeps the first as it was', async () => {
    const first = await report('entry-a', 'before the rebuild')
    saved = savedView({ fingerprint: REBUILT_FINGERPRINT })
    setClock(HOUR)

    const second = await report('entry-a', 'after the rebuild')

    expect(second.created).toBe(true)
    expect(second.id).not.toBe(first.id)
    expect(await repository.find(first.id)).toMatchObject({ fingerprint: FINGERPRINT, note: 'before the rebuild' })
    expect(await repository.find(second.id)).toMatchObject({ fingerprint: REBUILT_FINGERPRINT, note: 'after the rebuild' })
  })

  it('raises the alert again for a report on a rebuilt verdict in a later window', async () => {
    await report('entry-a', null)
    saved = savedView({ fingerprint: REBUILT_FINGERPRINT })
    setClock(DAY)

    await report('entry-a', null)

    expect(alertsQueued()).toEqual(['verdict-report', 'verdict-report'])
  })
})

describe('VerdictReportsService.reportMistake: the order of the checks', () => {
  it('refuses a caller with no session with AUTH_REQUIRED, before anything is read', async () => {
    expect(await errorOf(report('entry-a', 'a note', PUBLIC))).toMatchObject({ code: 'AUTH_REQUIRED' })

    expect(savedForCalls).toEqual([])
    expect(upsertCalls).toBe(0)
  })

  it('refuses a guest with 403 SIGNUP_REQUIRED, reading and storing nothing', async () => {
    expect(await errorOf(report('entry-a', 'a note', NGOZI))).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })

    expect(savedForCalls).toEqual([])
    expect(upsertCalls).toBe(0)
    expect(alertsQueued()).toEqual([])
  })

  it('turns a guest away before the note is looked at: a guest with a note that is too long gets 403, not 400', async () => {
    expect(await errorOf(report('entry-a', 'x'.repeat(600), NGOZI))).toMatchObject({ code: 'SIGNUP_REQUIRED' })
  })

  it('looks at the note before the verdict: a note that is too long for an entry that is not in the verdict gets 400, not 404', async () => {
    expect(await errorOf(report('entry-unknown', 'x'.repeat(600)))).toMatchObject({ name: 'ValidationError', code: 'VALIDATION_FAILED' })

    expect(savedForCalls).toEqual([])
  })

  it('looks at the note before the verdict: a note that is too long when there is no served verdict gets 400, not 404', async () => {
    saved = null

    expect(await errorOf(report('entry-a', 'x'.repeat(600)))).toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})

describe('VerdictReportsService.reportMistake: the note', () => {
  it('keeps a note of exactly 500 characters as given', async () => {
    const note = 'a'.repeat(500)

    const answer = await report('entry-a', note)

    expect((await repository.find(answer.id))!.note).toBe(note)
  })

  it('refuses a note of 501 characters with 400 VALIDATION_FAILED, storing and raising nothing', async () => {
    expect(await errorOf(report('entry-a', 'a'.repeat(501)))).toMatchObject({ name: 'ValidationError', code: 'VALIDATION_FAILED' })

    expect(upsertCalls).toBe(0)
    expect(alertsQueued()).toEqual([])
  })

  it('trims the note before counting it: 500 characters with spaces around them is accepted, stored without the spaces', async () => {
    const answer = await report('entry-a', `  ${'a'.repeat(500)}  `)

    expect((await repository.find(answer.id))!.note).toBe('a'.repeat(500))
  })

  it('still refuses 501 characters with spaces around them', async () => {
    expect(await errorOf(report('entry-a', ` ${'a'.repeat(501)} `))).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('trims a note and keeps the words inside it as they are', async () => {
    const answer = await report('entry-a', '  It is not  my cream \n')

    expect((await repository.find(answer.id))!.note).toBe('It is not  my cream')
  })

  it.each([['an empty note', ''], ['a note of spaces', '   '], ['a note of line breaks and tabs', '\n\t \n'], ['no note', undefined], ['a null note', null]])('stores %s as a null note', async (_label, note) => {
    const answer = await report('entry-a', note)

    expect((await repository.find(answer.id))!.note).toBeNull()
  })
})

describe('VerdictReportsService.reportMistake: a product that is not in the verdict being served', () => {
  it('refuses an entry the verdict has no product for with 404 VERDICT_PRODUCT_NOT_FOUND, storing and raising nothing', async () => {
    expect(await errorOf(report('entry-unknown', 'a note'))).toMatchObject({ name: 'NotFoundError', code: 'VERDICT_PRODUCT_NOT_FOUND' })

    expect(upsertCalls).toBe(0)
    expect(alertsQueued()).toEqual([])
  })

  it('refuses every entry with 404 VERDICT_PRODUCT_NOT_FOUND when there is no verdict being served (pending, stale or gated), even one that was in an earlier verdict', async () => {
    saved = null

    expect(await errorOf(report('entry-a', 'a note'))).toMatchObject({ name: 'NotFoundError', code: 'VERDICT_PRODUCT_NOT_FOUND' })

    expect(upsertCalls).toBe(0)
    expect(alertsQueued()).toEqual([])
  })

  it('refuses an entry that was in the verdict before it was rebuilt without it', async () => {
    saved = savedView({ fingerprint: REBUILT_FINGERPRINT, products: products().filter((product) => product.entryId !== 'entry-c') })

    expect(await errorOf(report('entry-c', null))).toMatchObject({ code: 'VERDICT_PRODUCT_NOT_FOUND' })
  })
})

describe('VerdictReportsService.reportMistake: the note stays private', () => {
  /** Everything the run left anywhere a note could leak to: the console, the error, the jobs, and the alert email once it is sent. */
  const leaks = async (spies: ReturnType<typeof spyOnConsole>, error?: Error) => {
    // Deliver every alert job, so the email the team would read is part of what is searched.
    for (const job of jobs.enqueued.filter((queued) => queued.job === 'send-ops-alert')) await opsAlerts.send(sendOpsAlertSpec.schema.parse(job.body))
    return JSON.stringify({
      console: loggedBy(spies),
      error: error ? { name: error.name, message: error.message, text: String(error), json: JSON.stringify(error), code: (error as { code?: string }).code } : null,
      jobs: jobs.enqueued,
      email: email.sent,
    })
  }

  it('is in no console output, job message or alert email when a report is made, and not when it is updated', async () => {
    const spies = spyOnConsole()

    await report('entry-a', MARKER)
    setClock(DAY)
    await report('entry-a', `${MARKER} again`)

    expect(await leaks(spies)).not.toContain(MARKER)
  })

  it('is in no console output, error, job message or email when the repository fails', async () => {
    const spies = spyOnConsole()
    ;(repository as WatchedReports).fails = new Error('d1 is down')

    const error = await errorOf(report('entry-a', MARKER))

    expect(await leaks(spies, error)).not.toContain(MARKER)
  })

  it('is in no console output, error, job message or email when the verdict cannot be read', async () => {
    const spies = spyOnConsole()
    savedForFails = new Error('the workbook is down')

    const error = await errorOf(report('entry-a', MARKER))

    expect(await leaks(spies, error)).not.toContain(MARKER)
  })

  it('is in no console output, error, job message or email when the entry is not in the verdict', async () => {
    const spies = spyOnConsole()

    const error = await errorOf(report('entry-unknown', MARKER))

    expect(await leaks(spies, error)).not.toContain(MARKER)
  })

  it('is in no console output, error, job message or email when the note is too long', async () => {
    const spies = spyOnConsole()

    const error = await errorOf(report('entry-a', MARKER.repeat(30)))

    expect(await leaks(spies, error)).not.toContain(MARKER)
  })

  it('is in no console output, error, job message or email for a guest who sends one', async () => {
    const spies = spyOnConsole()

    const error = await errorOf(report('entry-a', MARKER, NGOZI))

    expect(await leaks(spies, error)).not.toContain(MARKER)
  })

  it('leaves an alert email that names no product, profile, entry or note', async () => {
    const spies = spyOnConsole()
    await report('entry-b', MARKER)

    const everything = await leaks(spies)

    expect(email.sent).toHaveLength(1)
    for (const secret of ['entry-b', 'profile-amara-1', 'user-amara', 'Clobetasol', 'Karo', MARKER]) expect(everything).not.toContain(secret)
  })
})

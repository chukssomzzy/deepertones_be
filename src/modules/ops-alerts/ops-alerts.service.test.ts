import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseEmailAddress } from '../../lib/email-address'
import { EmailDeliveryError } from '../../providers/email/email.provider'
import { MemoryEmailSender } from '../../providers/email/memory.email'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { sendOpsAlertSpec } from './ops-alerts.job-specs'
import { FakeOpsAlertsRepository } from './ops-alerts.repository.fake'
import { OpsAlertsService } from './ops-alerts.service'
import type { OpsAlertKind } from './ops-alerts.types'

// The repository contract (fake and D1) is mounted by ops-alerts.repository.test.ts and its integration twin.

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Midnight UTC at the start of the day every test runs in. Written out, so the window edges do not come from the code under test. */
const DAY_START = new Date('2030-06-15T00:00:00.000Z')
const HOUR_START = new Date(DAY_START.getTime() + 12 * HOUR)
const T0 = new Date(HOUR_START.getTime() + 30 * MINUTE)
const RECIPIENT = 'ops@example.com'

const HOURLY: OpsAlertKind[] = ['ai-account']
const DAILY: OpsAlertKind[] = ['ai-spend-cap', 'research-budget', 'analysis-budget']

const setup = (options: { recipient?: string; repository?: FakeOpsAlertsRepository } = {}) => {
  let clock = T0
  const repository = options.repository ?? new FakeOpsAlertsRepository()
  const jobs = new MemoryJobQueue()
  const email = new MemoryEmailSender()
  const service = new OpsAlertsService({
    repository,
    jobs,
    email,
    recipient: options.recipient ?? RECIPIENT,
    environment: 'staging',
    now: () => clock,
  })
  return { service, repository, jobs, email, at: (time: Date) => (clock = time) }
}

/** What the queue was asked to send: the kind and window of each message, and the key the dispatcher would dedupe it by. */
const alertsQueued = (jobs: MemoryJobQueue) =>
  jobs.enqueued.map((e) => {
    const body = e.body as { kind: OpsAlertKind; windowStart: number }
    return { job: e.job, kind: body.kind, windowStart: body.windowStart, key: sendOpsAlertSpec.key(body) }
  })

/** Whatever the service logs, however it logs it. */
const spyOnLogs = () => {
  const spies = (['error', 'warn', 'info', 'log'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
  return () => spies.flatMap((spy) => spy.mock.calls.map((call) => call[0]))
}

afterEach(() => vi.restoreAllMocks())

describe('OpsAlertsService.raise', () => {
  it('queues one send-ops-alert job for an hourly kind, in the window of the hour it was raised in', async () => {
    const { service, jobs } = setup()

    await service.raise('ai-account')

    expect(alertsQueued(jobs)).toEqual([
      { job: 'send-ops-alert', kind: 'ai-account', windowStart: HOUR_START.getTime(), key: `ai-account:${HOUR_START.getTime()}` },
    ])
  })

  it.each(DAILY)('queues one job for the daily kind %s, in the window of the UTC day it was raised in', async (kind) => {
    const { service, jobs } = setup()

    await service.raise(kind)

    expect(alertsQueued(jobs)).toEqual([{ job: 'send-ops-alert', kind, windowStart: DAY_START.getTime(), key: `${kind}:${DAY_START.getTime()}` }])
  })

  it('queues one job, not one per raise, when the same kind is raised again in the same window', async () => {
    const { service, jobs } = setup()

    await service.raise('ai-account')
    await service.raise('ai-account')
    await service.raise('ai-account')

    expect(jobs.enqueued).toHaveLength(1)
  })

  it.each([...HOURLY, ...DAILY])('queues exactly one job for %s when many callers raise it at the same moment', async (kind) => {
    const { service, jobs } = setup()

    await Promise.all(Array.from({ length: 10 }, () => service.raise(kind)))

    expect(alertsQueued(jobs).map((a) => a.kind)).toEqual([kind])
  })

  it('keeps the kinds apart: each kind gets its own job in the same moment', async () => {
    const { service, jobs } = setup()

    await service.raise('ai-account')
    await service.raise('ai-spend-cap')
    await service.raise('research-budget')
    await service.raise('analysis-budget')

    expect(alertsQueued(jobs).map((a) => a.kind).sort()).toEqual(['ai-account', 'ai-spend-cap', 'analysis-budget', 'research-budget'])
  })

  describe('the hourly window', () => {
    it('still dedupes at the last millisecond of the hour', async () => {
      const { service, jobs, at } = setup()
      await service.raise('ai-account')

      at(new Date(HOUR_START.getTime() + HOUR - 1))
      await service.raise('ai-account')

      expect(jobs.enqueued).toHaveLength(1)
    })

    it('sends again at the first millisecond of the next hour, for that hour\'s window', async () => {
      const { service, jobs, at } = setup()
      await service.raise('ai-account')

      at(new Date(HOUR_START.getTime() + HOUR))
      await service.raise('ai-account')

      expect(alertsQueued(jobs).map((a) => a.windowStart)).toEqual([HOUR_START.getTime(), HOUR_START.getTime() + HOUR])
    })

    it('counts a raise exactly at the top of an hour toward the hour that begins there', async () => {
      const { service, jobs, at } = setup()
      at(HOUR_START)

      await service.raise('ai-account')

      expect(alertsQueued(jobs)[0]!.windowStart).toBe(HOUR_START.getTime())
    })
  })

  describe('the daily window (UTC)', () => {
    it.each(DAILY)('still dedupes %s at the last millisecond of the day, even though the hour has changed', async (kind) => {
      const { service, jobs, at } = setup()
      await service.raise(kind)

      at(new Date(DAY_START.getTime() + 13 * HOUR))
      await service.raise(kind)
      at(new Date(DAY_START.getTime() + DAY - 1))
      await service.raise(kind)

      expect(jobs.enqueued).toHaveLength(1)
    })

    it.each(DAILY)('sends %s again at midnight UTC, for the new day\'s window', async (kind) => {
      const { service, jobs, at } = setup()
      await service.raise(kind)

      at(new Date(DAY_START.getTime() + DAY))
      await service.raise(kind)

      expect(alertsQueued(jobs).map((a) => a.windowStart)).toEqual([DAY_START.getTime(), DAY_START.getTime() + DAY])
    })
  })

  describe('when it cannot raise the alert', () => {
    it('does not throw, and logs ops-alert-failed with the kind, when the repository fails', async () => {
      const logged = spyOnLogs()
      class Down extends FakeOpsAlertsRepository {
        override async claim(): Promise<boolean> {
          throw new Error('d1 is down')
        }
      }
      const { service, jobs } = setup({ repository: new Down() })

      await expect(service.raise('ai-spend-cap')).resolves.toBeUndefined()

      expect(logged()).toContainEqual(expect.objectContaining({ outcome: 'ops-alert-failed', kind: 'ai-spend-cap' }))
      expect(jobs.enqueued).toEqual([])
    })

    it('does not throw, and logs ops-alert-failed with the kind, when the job cannot be queued', async () => {
      const logged = spyOnLogs()
      const { service, jobs } = setup()
      jobs.failNextWith(new Error('queue is down'))

      await expect(service.raise('ai-account')).resolves.toBeUndefined()

      expect(logged()).toContainEqual(expect.objectContaining({ outcome: 'ops-alert-failed', kind: 'ai-account' }))
    })

    it('never puts the error text or anything secret in the log line', async () => {
      const logged = spyOnLogs()
      const { service, jobs } = setup()
      jobs.failNextWith(new Error('sk-ant-secret-key in the queue error'))

      await service.raise('ai-account')

      expect(JSON.stringify(logged())).not.toContain('sk-ant-secret-key')
    })
  })
})

describe('OpsAlertsService.send', () => {
  const window = { windowStart: HOUR_START.getTime() }

  it('emails the configured address, once, for the alert', async () => {
    const { service, email } = setup()

    await service.send({ kind: 'ai-account', ...window })

    expect(email.sent).toHaveLength(1)
    expect(email.sent[0]!.to).toBe(parseEmailAddress(RECIPIENT))
  })

  it.each([...HOURLY, ...DAILY])('names the environment and the kind in the %s email, in plain text', async (kind) => {
    const { service, email } = setup()

    await service.send({ kind, ...window })

    const sent = email.sent[0]!
    expect(sent.subject).toContain('staging')
    expect(sent.subject).toContain(kind)
    expect(sent.text).toContain('staging')
    expect(sent.text).toContain(kind)
  })

  it('writes different text for each kind', async () => {
    const { service, email } = setup()

    for (const kind of [...HOURLY, ...DAILY]) await service.send({ kind, ...window })

    expect(new Set(email.sent.map((m) => m.text)).size).toBe(4)
  })

  it('writes the same text for a kind whatever window it is for: the text is fixed and carries no data', async () => {
    const { service, email } = setup()

    await service.send({ kind: 'ai-spend-cap', windowStart: DAY_START.getTime() })
    await service.send({ kind: 'ai-spend-cap', windowStart: DAY_START.getTime() + DAY })

    expect(email.sent[0]!.text).toBe(email.sent[1]!.text)
    expect(email.sent[0]!.subject).toBe(email.sent[1]!.subject)
  })

  it.each(['', '   '])('logs ops-alert-no-recipient with the kind, sends nothing and does not throw, when the address is %j', async (recipient) => {
    const logged = spyOnLogs()
    const { service, email } = setup({ recipient })

    await expect(service.send({ kind: 'research-budget', ...window })).resolves.toBeUndefined()

    expect(email.sent).toEqual([])
    expect(logged()).toContainEqual(expect.objectContaining({ outcome: 'ops-alert-no-recipient', kind: 'research-budget' }))
  })

  it('lets the job retry (throws) when the email provider is unavailable, so the alert is not lost', async () => {
    const { service, email } = setup()
    const outage = new EmailDeliveryError('unavailable', 'zeptomail is down')
    email.failNextWith(outage)

    await expect(service.send({ kind: 'ai-account', ...window })).rejects.toBe(outage)
  })
})

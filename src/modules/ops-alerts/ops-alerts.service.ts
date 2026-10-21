import { renderEmail } from '../../emails/registry'
import { parseEmailAddress } from '../../lib/email-address'
import { describeUnexpectedError } from '../../lib/safe-error'
import type { EmailSender } from '../../providers/email/email.provider'
import type { JobQueue } from '../../providers/job-queue/job-queue.provider'
import { type SendOpsAlertMessage, sendOpsAlertSpec } from './ops-alerts.job-specs'
import type { OpsAlertsRepository } from './ops-alerts.repository'
import type { OpsAlertKind } from './ops-alerts.types'

export type OpsAlertsServiceDeps = {
  repository: OpsAlertsRepository
  jobs: JobQueue
  email: EmailSender
  /** Where alerts go (OPS_ALERT_EMAIL). Empty is allowed: the alert is then logged and dropped. */
  recipient: string
  /** Named in the email, so a staging alert is not mistaken for production. */
  environment: string
  now?: () => Date
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** How often each kind may email, and what the email says. The text is fixed and carries no data: nothing secret or personal can reach an inbox. */
const ALERTS: Record<OpsAlertKind, { windowMs: number; what: string; todo: string }> = {
  'ai-account': {
    windowMs: HOUR,
    what: 'Claude refused our account: no credit, an invalid API key, or missing permissions. Scan steps that need Claude are waiting and ask again every 5 minutes; an item gives up after 2 hours.',
    todo: 'Check the billing and the API key in the Anthropic console.',
  },
  'face-scan-account': {
    windowMs: HOUR,
    what: 'Perfect Corp refused our account: no units left, an invalid API key, or missing permissions. Face scans that hit it end as unavailable.',
    todo: 'Check the unit balance and the API key in the Perfect Corp console.',
  },
  'ai-spend-cap': {
    windowMs: DAY,
    what: "Today's AI spend passed AI_DAILY_BUDGET_USD. Every call still goes ahead and is still recorded.",
    todo: 'Run npm run ai:spend to see where it went, and raise the figure if the spend is expected.',
  },
  'research-budget': {
    windowMs: DAY,
    what: "More new-product research attempts than the catalog's daily research budget were made in 24 hours. Every attempt still goes ahead.",
    todo: 'Check that the scans behind it are real, and raise dailyResearchBudget in catalog.service.ts if they are.',
  },
  'analysis-budget': {
    windowMs: DAY,
    what: "More analysis attempts than the catalog's daily analysis budget were made in 24 hours. Every attempt still goes ahead.",
    todo: 'Check that the formulations behind it are real, and raise dailyAnalysisBudget in catalog.service.ts if they are.',
  },
}

/**
 * Emails the owner when an environment-wide problem needs them: Claude or Perfect Corp refusing our account (at most once an hour each) or a daily limit
 * passed (once a day, per limit). The limits never refuse anyone; this is how they are noticed.
 *
 * `raise` is called from the paths that hit the problem, so it NEVER throws and costs them one guarded write at most. It claims the
 * window first (see the repository), so however many callers hit the problem in a window, one job is queued; the email is sent
 * by the job, so a provider outage is retried and a slow one never holds up a scan.
 */
export class OpsAlertsService {
  private readonly repository: OpsAlertsRepository
  private readonly jobs: JobQueue
  private readonly email: EmailSender
  private readonly recipient: string
  private readonly environment: string
  private readonly now: () => Date

  constructor(deps: OpsAlertsServiceDeps) {
    this.repository = deps.repository
    this.jobs = deps.jobs
    this.email = deps.email
    this.recipient = deps.recipient
    this.environment = deps.environment
    this.now = deps.now ?? (() => new Date())
  }

  async raise(kind: OpsAlertKind): Promise<void> {
    try {
      const { windowMs } = ALERTS[kind]
      const windowStart = Math.floor(this.now().getTime() / windowMs) * windowMs
      if (!(await this.repository.claim(kind, new Date(windowStart)))) return
      // The window is claimed before the job is queued, so a queue outage loses this window's email (the next window sends); the alternative is one email per caller.
      await this.jobs.enqueue(sendOpsAlertSpec, { kind, windowStart })
    } catch (error) {
      console.error({ outcome: 'ops-alert-failed', kind, error: describeUnexpectedError(error) })
    }
  }

  /** The job's work: one email to the configured address. A provider failure is thrown, for the queue to retry. */
  async send({ kind, windowStart }: SendOpsAlertMessage): Promise<void> {
    const to = this.recipientAddress()
    if (!to) {
      console.error({ outcome: 'ops-alert-no-recipient', kind })
      return
    }
    const { what, todo } = ALERTS[kind]
    await this.email.send({ ...renderEmail('ops-alert', { environment: this.environment, kind, what, todo }), to, reference: `${kind}:${windowStart}` })
  }

  /** Undefined when none is set or it is not an address: retrying a bad config cannot help, so the job drops the alert with a log line. */
  private recipientAddress() {
    if (this.recipient.trim() === '') return undefined
    try {
      return parseEmailAddress(this.recipient)
    } catch {
      return undefined
    }
  }
}

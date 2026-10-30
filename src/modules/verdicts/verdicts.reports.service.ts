import { requireUser } from '../../lib/context'
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors'
import type { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import type { VerdictReportsRepository } from './verdicts.reports.repository'
import type { VerdictService } from './verdicts.service'

export type VerdictReportsServiceDeps = {
  repository: VerdictReportsRepository
  verdicts: Pick<VerdictService, 'savedFor'>
  opsAlerts: Pick<OpsAlertsService, 'raise'>
  now: () => Date
}

const MAX_NOTE_LENGTH = 500

/**
 * "Report a mistake" (spec #259): a signed-up person tells the team that a product's verdict looks wrong. It stores the report and raises the `verdict-report` ops alert for a new one;
 * it never changes the verdict. The note is the person's own words for the team: it goes into the report row and nowhere else. It is never logged, never named in an error, an alert
 * or a job message, and never sent to a model, so nothing here catches an error to log it, and every message is fixed text.
 */
export class VerdictReportsService {
  private readonly repository: VerdictReportsRepository
  private readonly verdicts: Pick<VerdictService, 'savedFor'>
  private readonly opsAlerts: Pick<OpsAlertsService, 'raise'>
  private readonly now: () => Date

  constructor(deps: VerdictReportsServiceDeps) {
    this.repository = deps.repository
    this.verdicts = deps.verdicts
    this.opsAlerts = deps.opsAlerts
    this.now = deps.now
  }

  /**
   * Reports the session profile's product `entryId` as wrongly judged. Checks, in order: 401, 403 `SIGNUP_REQUIRED` for a guest, 400 `VALIDATION_FAILED` for a note over 500 characters
   * once trimmed (an empty one is no note), then 404 `VERDICT_PRODUCT_NOT_FOUND` unless the entry is a product of the verdict the person would be served right now (`savedFor`: ready
   * and built from the inputs as they are now, so never a stale or pending one). Reporting the same entry on the same verdict again updates the first report (`created: false`).
   */
  async reportMistake(entryId: string, note?: string | null): Promise<{ id: string; created: boolean }> {
    const { profileId } = VerdictReportsService.signedUp()
    const kept = VerdictReportsService.noteOf(note)
    const saved = await this.verdicts.savedFor(profileId)
    const product = saved?.products.find((candidate) => candidate.entryId === entryId)
    if (!saved || !product) throw new NotFoundError('VERDICT_PRODUCT_NOT_FOUND', 'That product is not in your verdict')
    const result = await this.repository.upsertMistake(
      { id: crypto.randomUUID(), profileId, entryId, group: product.group, verdict: product.verdict, basis: product.basis, fingerprint: saved.fingerprint, note: kept },
      this.now(),
    )
    // One alert per new report; the alert names nothing (not the product, the profile or the note).
    if (result.created) await this.opsAlerts.raise('verdict-report')
    return result
  }

  private static signedUp() {
    const user = requireUser()
    if (user.status !== 'verified') throw new ForbiddenError('SIGNUP_REQUIRED', 'Sign up to report a mistake')
    return user
  }

  /** The note trimmed, null when there is none. The error is fixed text: it never carries the note or its length. */
  private static noteOf(note: string | null | undefined): string | null {
    const trimmed = note?.trim() ?? ''
    if (trimmed.length > MAX_NOTE_LENGTH) throw new ValidationError('VALIDATION_FAILED', `A note is at most ${MAX_NOTE_LENGTH} characters`)
    return trimmed === '' ? null : trimmed
  }
}

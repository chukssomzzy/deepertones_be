import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { stepPauses } from './skin-care.table'
import type { NewStepPause, StepPause } from './skin-care.types'
import type { PauseState } from './skin-care.vocabulary'

/** The fields of a pause that change after it is made. */
export type StepPausePatch = Partial<Pick<StepPause, 'state' | 'checkDay' | 'sameCount' | 'ladderCode' | 'ladderStartedOn' | 'versionId'>>

export class D1StepPausesRepository {
  constructor(private readonly db: Db) {}

  /** Stores the pause as given and answers it whole. Rejects an id already held, a profile that does not exist, a second open pause for the same step and product, and a second open pause with no step. */
  async insert(pause: NewStepPause): Promise<StepPause> {
    const [row] = await this.db.insert(stepPauses).values(pause).returning()
    return row!
  }

  /** The profile's pause in any state; null for another profile's and for an id nobody holds. */
  async find(profileId: string, id: string): Promise<StepPause | null> {
    const [row] = await this.db.select().from(stepPauses).where(and(eq(stepPauses.id, id), eq(stepPauses.profileId, profileId))).limit(1)
    return row ?? null
  }

  /** The profile's open pauses (`paused`, `bringing-back` and `escalated`), oldest first (made in the same millisecond by id, so the order is stable), whole. */
  async openFor(profileId: string): Promise<StepPause[]> {
    return this.db
      .select()
      .from(stepPauses)
      .where(and(eq(stepPauses.profileId, profileId), inArray(stepPauses.state, ['paused', 'bringing-back', 'escalated'])))
      .orderBy(asc(stepPauses.createdAt), asc(stepPauses.id))
  }

  /**
   * Sets exactly the fields given on the profile's pause. False for another profile's pause and for an id nobody holds; an empty patch on a pause that exists is true and
   * changes nothing. With `onlyIfState`, the pause must be in that state when it is written (a compare-and-set, so a pause another request has closed is left as it is: false).
   */
  async update(profileId: string, id: string, patch: StepPausePatch, onlyIfState?: PauseState): Promise<boolean> {
    const where = and(eq(stepPauses.id, id), eq(stepPauses.profileId, profileId), onlyIfState === undefined ? undefined : eq(stepPauses.state, onlyIfState))
    if (Object.keys(patch).length === 0) {
      const row = await this.find(profileId, id)
      return row !== null && (onlyIfState === undefined || row.state === onlyIfState)
    }
    const rows = await this.db.update(stepPauses).set(patch).where(where).returning({ id: stepPauses.id })
    return rows.length > 0
  }

  /**
   * A harm signal on a step being brought back: flips that row to `paused` in place (a second open row for the step is refused by the table), with the new day, check day and log and no
   * "same" answers, and keeps the ladder columns. A compare-and-set on `bringing-back`: false, changing nothing, for a row in any other state, another profile's row and an id nobody holds.
   */
  async rePause(profileId: string, id: string, to: { pausedOn: string; checkDay: string; sourceLogId: string | null }): Promise<boolean> {
    const rows = await this.db
      .update(stepPauses)
      .set({ state: 'paused', sameCount: 0, pausedOn: to.pausedOn, checkDay: to.checkDay, sourceLogId: to.sourceLogId })
      .where(and(eq(stepPauses.id, id), eq(stepPauses.profileId, profileId), eq(stepPauses.state, 'bringing-back')))
      .returning({ id: stepPauses.id })
    return rows.length > 0
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type StepPausesRepository = PublicOf<D1StepPausesRepository>

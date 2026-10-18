import { requireUser } from '../../lib/context'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { GOAL_ANSWERS_VERSION, answerFor } from './goals.answers'
import type { GoalsRepository } from './goals.repository'
import type { GoalRow, GoalView, OnboardingView } from './goals.types'
import type { Goal } from './goals.vocabulary'

export type GoalsServiceDeps = {
  repository: GoalsRepository
  now?: () => Date
  newId?: () => string
}

/** One goal chip, or the user's own words. The wire schema makes sure it is exactly one, and that the words are 1 to 200 characters once trimmed. */
export type SetGoalInput = { goal: Goal } | { text: string }

/**
 * A profile's goal, as history: every change appends a row and the newest is the current goal. A guest has one as much as a verified
 * user, and it stays with the profile when the guest signs up. What the app shows (the answer) is worked out from the row on each
 * read, so a new version of the copy reaches goals saved earlier.
 */
export class GoalsService {
  // Typed words are shown back to the user and later read by a model, so they carry no link, markup or invisible character.
  private static readonly INVISIBLE = /[\p{Cc}\p{Cf}]/u

  private readonly repository: GoalsRepository
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(deps: GoalsServiceDeps) {
    this.repository = deps.repository
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Saves a goal for the caller's profile and answers what the app shows for it. Typed words are saved with no goal (nothing sorts
   * them into one yet). A chip picked right after such words keeps them, because the pick answers "which is closest?"; a chip
   * after anything else leaves the text empty, so old words do not follow later changes. Never logs the words.
   */
  async set(input: SetGoalInput): Promise<GoalView> {
    const { profileId } = requireUser()
    let goal: Goal | null = null
    let text: string | null
    if ('goal' in input) {
      goal = input.goal
      const current = await this.repository.current(profileId)
      text = current && current.goal === null ? current.text : null
    } else {
      text = input.text.trim()
      if (hasLinkOrMarkup(text) || GoalsService.INVISIBLE.test(text)) {
        throw new ValidationError('INVALID_GOAL_TEXT', 'Use plain words for your goal, with no links or markup')
      }
    }
    const row: GoalRow = { id: this.newId(), profileId, text, goal, wantsLighter: false, answersVersion: GOAL_ANSWERS_VERSION, createdAt: this.now() }
    await this.repository.append(row)
    return this.view(row)
  }

  /** The caller's current goal. Typed words with no goal yet are a goal view with no answer; only a profile that never set anything is 404 `GOAL_NOT_SET`. */
  async current(): Promise<GoalView> {
    const { profileId } = requireUser()
    const row = await this.repository.current(profileId)
    if (!row) throw new NotFoundError('GOAL_NOT_SET', 'No goal has been set')
    return this.view(row)
  }

  /** Which first-run step comes next: the goal until one is picked (typed words alone do not count), then safety. */
  async onboarding(): Promise<OnboardingView> {
    const { profileId } = requireUser()
    const row = await this.repository.current(profileId)
    return { goal: row ? this.view(row) : null, safety: null, next: row?.goal ? 'safety' : 'goal' }
  }

  private view(row: GoalRow): GoalView {
    return {
      goal: row.goal,
      wantsLighter: row.wantsLighter,
      text: row.text,
      answer: row.goal ? answerFor(row.goal, row.wantsLighter) : null,
      answersVersion: GOAL_ANSWERS_VERSION,
      updatedAt: row.createdAt,
    }
  }
}

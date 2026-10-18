import { requireUser } from '../../lib/context'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { AiBudgetExceededError } from '../../providers/anthropic/ai-spend.provider'
import { AnthropicRefusalError, AnthropicRequestError, AnthropicUnavailableError } from '../../providers/anthropic/anthropic.provider'
import type { GoalReader, GoalReading } from '../../providers/goal-reading/goal-reader.provider'
import type { SafetyService } from '../safety/safety.service'
import { GOAL_ANSWERS_VERSION, answerFor } from './goals.answers'
import type { GoalsRepository } from './goals.repository'
import type { GoalRow, GoalView, OnboardingView } from './goals.types'
import type { Goal } from './goals.vocabulary'

export type GoalsServiceDeps = {
  repository: GoalsRepository
  reader: GoalReader
  /** Asked through its service for the onboarding step, never through its repository. */
  safety: Pick<SafetyService, 'currentOrNull'>
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
  private readonly reader: GoalReader
  private readonly safety: Pick<SafetyService, 'currentOrNull'>
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(deps: GoalsServiceDeps) {
    this.repository = deps.repository
    this.reader = deps.reader
    this.safety = deps.safety
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Saves a goal for the caller's profile and answers what the app shows for it. Typed words are read by the goal reader: the goal it
   * finds is saved with them, and when it finds none, or cannot read them (a spend cap, an outage, a refusal), they are saved with no goal
   * so the app falls back to the chips. A chip picked right after words with no goal keeps them, because the pick answers "which is
   * closest?"; a chip after anything else leaves the text empty, so old words do not follow later changes. Never logs the words.
   */
  async set(input: SetGoalInput): Promise<GoalView> {
    const { profileId } = requireUser()
    let reading: GoalReading = { goal: null, wantsLighter: false }
    let text: string | null
    if ('goal' in input) {
      reading = { goal: input.goal, wantsLighter: false }
      const current = await this.repository.current(profileId)
      text = current && current.goal === null ? current.text : null
    } else {
      text = input.text.trim()
      if (hasLinkOrMarkup(text) || GoalsService.INVISIBLE.test(text)) {
        throw new ValidationError('INVALID_GOAL_TEXT', 'Use plain words for your goal, with no links or markup')
      }
      reading = await this.read(text)
    }
    const row: GoalRow = { id: this.newId(), profileId, text, goal: reading.goal, wantsLighter: reading.wantsLighter, answersVersion: GOAL_ANSWERS_VERSION, createdAt: this.now() }
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

  /**
   * The guard for what must not be built on a missing goal (the verdict, the routine): the current goal, or 409 `GOAL_REQUIRED`. Typed words
   * nobody sorted into a goal are not a goal. Not wired to a route yet.
   */
  async requireGoal(): Promise<GoalView> {
    const { profileId } = requireUser()
    const row = await this.repository.current(profileId)
    if (!row?.goal) throw new ConflictError('GOAL_REQUIRED', 'Pick a goal first')
    return this.view(row)
  }

  /**
   * Which first-run step comes next: the goal until one is picked (typed words alone do not count), then the safety question until it is
   * answered, then the shelf. The safety answers come along whichever step it is, because the question can be answered before the goal.
   */
  async onboarding(): Promise<OnboardingView> {
    const { profileId } = requireUser()
    const row = await this.repository.current(profileId)
    const safety = await this.safety.currentOrNull()
    return { goal: row ? this.view(row) : null, safety, next: !row?.goal ? 'goal' : !safety ? 'safety' : 'shelf' }
  }

  /**
   * What the reader makes of the words. A failure that is the model's or the spend cap's (not ours to fix) reads as no goal, and is
   * logged once with a short reason. Anything else, a bad key above all, is a setup problem and is thrown rather than hidden.
   */
  private async read(text: string): Promise<GoalReading> {
    try {
      return await this.reader.read(text)
    } catch (error) {
      const reason = GoalsService.failureReason(error)
      if (!reason) throw error
      console.error({ outcome: 'goal-read-failed', reason })
      return { goal: null, wantsLighter: false }
    }
  }

  private static failureReason(error: unknown): string | undefined {
    if (error instanceof AiBudgetExceededError) return 'budget-exceeded'
    if (error instanceof AnthropicUnavailableError) return 'unavailable'
    if (error instanceof AnthropicRequestError) return 'request-rejected'
    if (error instanceof AnthropicRefusalError) return 'refused'
    return undefined
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

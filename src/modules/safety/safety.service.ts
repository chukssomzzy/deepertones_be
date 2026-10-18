import { requireUser } from '../../lib/context'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import type { SafetyRepository } from './safety.repository'
import type { SafetyRow, SafetyView } from './safety.types'
import { SAFETY_CHOICES, type SafetyChoice } from './safety.vocabulary'

export type SafetyServiceDeps = {
  repository: SafetyRepository
  now?: () => Date
  newId?: () => string
}

/**
 * The ticked choices, and the words typed beside "a product gave me a reaction" and "I use a prescription". The wire schema makes sure the
 * choices are one to 20 known ones (repeats are collapsed here) and each text is at most 300 characters once trimmed; the rules between them are the service's.
 */
export type SetSafetyInput = { choices: SafetyChoice[]; reactionText?: string; prescriptionText?: string }

type TextField = 'reactionText' | 'prescriptionText'

/**
 * A profile's safety answers, as history: every change appends a row and the newest is the current answer, whether it is stricter than the
 * one before or not. A guest has answers as much as a verified user, and they stay with the profile when the guest signs up.
 */
export class SafetyService {
  // The words are shown back to the user and later read by a model, so they carry no link, markup or invisible character.
  private static readonly INVISIBLE = /[\p{Cc}\p{Cf}]/u
  // Each text belongs to one choice and is refused without it.
  private static readonly TEXT_CHOICES = [
    ['reactionText', 'reaction'],
    ['prescriptionText', 'prescription'],
  ] as const satisfies readonly (readonly [TextField, SafetyChoice])[]

  private readonly repository: SafetyRepository
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(deps: SafetyServiceDeps) {
    this.repository = deps.repository
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Saves the answers for the caller's profile. The choices are kept once each, in the vocabulary's order. A text is trimmed and every run of
   * whitespace in it made one space; one that is then empty counts as no text, so an empty field says nothing. A text with words in it needs its
   * choice ticked ("none" included in that: it says none of it applies) and no link, markup or other control or invisible character. Nothing
   * carries over from the answer before. Never logs the words.
   */
  async set(input: SetSafetyInput): Promise<SafetyView> {
    const { profileId } = requireUser()
    const choices = SAFETY_CHOICES.filter((choice) => input.choices.includes(choice))
    const texts: Record<TextField, string | null> = {
      reactionText: SafetyService.tidy(input.reactionText),
      prescriptionText: SafetyService.tidy(input.prescriptionText),
    }
    if (choices.includes('none') && choices.length > 1) {
      throw new ValidationError('INVALID_SAFETY_ANSWER', '"None of these" cannot be combined with another choice', { field: 'choices' })
    }
    for (const [field, choice] of SafetyService.TEXT_CHOICES) {
      if (texts[field] !== null && !choices.includes(choice)) {
        throw new ValidationError('INVALID_SAFETY_ANSWER', `Words for ${field} need the matching choice to be ticked`, { field })
      }
    }
    for (const [field] of SafetyService.TEXT_CHOICES) {
      const text = texts[field]
      if (text !== null && (hasLinkOrMarkup(text) || SafetyService.INVISIBLE.test(text))) {
        throw new ValidationError('INVALID_SAFETY_TEXT', 'Use plain words, with no links or markup', { field })
      }
    }
    const row: SafetyRow = { id: this.newId(), profileId, choices, ...texts, createdAt: this.now() }
    await this.repository.append(row)
    return this.view(row)
  }

  /** The caller's current answers. 404 `SAFETY_NOT_SET` for a profile that never answered. */
  async current(): Promise<SafetyView> {
    const view = await this.currentOrNull()
    if (!view) throw new NotFoundError('SAFETY_NOT_SET', 'No safety answers have been set')
    return view
  }

  /** The caller's current answers, or null when the profile never answered. */
  async currentOrNull(): Promise<SafetyView | null> {
    const { profileId } = requireUser()
    const row = await this.repository.current(profileId)
    return row && this.view(row)
  }

  /**
   * The guard for what must not be built on a missing answer (the verdict, the routine): the current answers, or 409 `SAFETY_ANSWERS_REQUIRED`.
   * "None of these" is an answer. Not wired to a route yet.
   */
  async requireAnswered(): Promise<SafetyView> {
    const view = await this.currentOrNull()
    if (!view) throw new ConflictError('SAFETY_ANSWERS_REQUIRED', 'Answer the safety question first')
    return view
  }

  // Trimmed, with every run of whitespace (a line break, a tab) made one space, so a list written over several lines is one line. This comes before
  // everything that looks at the text, which is why a stray control character is still found: it is not whitespace. Empty is no text.
  private static tidy(text: string | undefined): string | null {
    return text?.trim().replace(/\s+/g, ' ') || null
  }

  private view(row: SafetyRow): SafetyView {
    return {
      choices: row.choices,
      reactionText: row.reactionText,
      prescriptionText: row.prescriptionText,
      excludesPregnancyCaution: row.choices.includes('pregnant') || row.choices.includes('breastfeeding'),
      updatedAt: row.createdAt,
    }
  }
}

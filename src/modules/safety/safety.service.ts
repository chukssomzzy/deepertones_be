import { requireUser } from '../../lib/context'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { AnthropicRefusalError, AnthropicRequestError } from '../../providers/anthropic/anthropic.provider'
import type { JobQueue } from '../../providers/job-queue/job-queue.provider'
import type { Mention, MentionReader } from '../../providers/mention-reading/mention-reader.provider'
import type { ProductCategory } from '../../providers/product-research/product-researcher.provider'
import { CatalogBusyError, type ProductCatalogService } from '../catalog/catalog.service'
import { parseSafetySpec } from './safety.job-specs'
import type { SafetyRepository } from './safety.repository'
import type { SafetyMentionRow, SafetyRow, SafetyView } from './safety.types'
import { SAFETY_CHOICES, type SafetyChoice } from './safety.vocabulary'

export type SafetyServiceDeps = {
  repository: SafetyRepository
  reader: MentionReader
  /** Only the two calls the parse makes: who a named product is, and its ingredients. Analysis stays the scan's business. */
  catalog: Pick<ProductCatalogService, 'resolve' | 'research'>
  jobs: JobQueue
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
 *
 * The words typed beside "a product gave me a reaction" and "I use a prescription" are parsed in the background into the products and
 * ingredients they name (see `parse`). The parse only adds: the words and the choices count whether or not it ever finishes.
 */
export class SafetyService {
  // The words are shown back to the user and later read by a model, so they carry no link, markup or invisible character.
  private static readonly INVISIBLE = /[\p{Cc}\p{Cf}]/u
  // Each text belongs to one choice and is refused without it.
  private static readonly TEXT_CHOICES = [
    ['reactionText', 'reaction'],
    ['prescriptionText', 'prescription'],
  ] as const satisfies readonly (readonly [TextField, SafetyChoice])[]

  private static readonly HOUR_MS = 60 * 60 * 1000
  // A parse still pending this long after it was due had its queue message lost; reading the answer queues it again.
  private static readonly OVERDUE_MS = 10 * 60 * 1000
  // Researching a product is a web search turn, so one answer may research at most this many (ingredients and unbranded things cost nothing).
  private static readonly MAX_PRODUCTS = 3
  private static readonly SOURCES = [
    ['reaction', 'reactionText'],
    ['prescription', 'prescriptionText'],
  ] as const satisfies readonly (readonly [SafetyMentionRow['source'], TextField])[]

  private readonly repository: SafetyRepository
  private readonly reader: MentionReader
  private readonly catalog: Pick<ProductCatalogService, 'resolve' | 'research'>
  private readonly jobs: JobQueue
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(deps: SafetyServiceDeps) {
    this.repository = deps.repository
    this.reader = deps.reader
    this.catalog = deps.catalog
    this.jobs = deps.jobs
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Saves the answers for the caller's profile. The choices are kept once each, in the vocabulary's order. A text is trimmed and every run of
   * whitespace in it made one space; one that is then empty counts as no text, so an empty field says nothing. A text with words in it needs its
   * choice ticked ("none" included in that: it says none of it applies) and no link, markup or other control or invisible character. Nothing
   * carries over from the answer before. Words to parse make the row `pending` and queue its parse, held back so that a profile parses at most once an
   * hour; a queue that is down is logged and the row stays pending, to be queued again by the next save or read. Never logs the words.
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
    const now = this.now()
    const hasWords = texts.reactionText !== null || texts.prescriptionText !== null
    const delaySeconds = hasWords ? await this.parseDelaySeconds(profileId, now) : 0
    const row: SafetyRow = {
      id: this.newId(),
      profileId,
      choices,
      ...texts,
      parseState: hasWords ? 'pending' : 'none',
      parseDueAt: hasWords ? new Date(now.getTime() + delaySeconds * 1000) : null,
      createdAt: now,
    }
    await this.repository.append(row)
    if (hasWords) await this.queueParse(row.id, delaySeconds)
    return this.view(row)
  }

  /**
   * The caller's current answers. 404 `SAFETY_NOT_SET` for a profile that never answered. A parse that is still pending long after it was due
   * (its queue message was lost, or the queue was down when the answer was saved) is queued again; that never fails the read.
   */
  async current(): Promise<SafetyView> {
    const row = await this.currentRow()
    if (!row) throw new NotFoundError('SAFETY_NOT_SET', 'No safety answers have been set')
    await this.repairParse(row)
    return this.view(row)
  }

  /** The caller's current answers, or null when the profile never answered. */
  async currentOrNull(): Promise<SafetyView | null> {
    const row = await this.currentRow()
    return row && this.view(row)
  }

  /** The products and ingredients parsed from the caller's current answer, in the order found; empty while there is nothing parsed (yet). */
  async currentMentions(): Promise<SafetyMentionRow[]> {
    const row = await this.currentRow()
    return row ? this.repository.mentions(row.id) : []
  }

  /**
   * The background parse of one answer's words, run by the queue as the system actor and safe to run again. A row that is not pending, or that a newer
   * answer has replaced (that one has its own job), is finished without a call. The words are read once, both before anything is stored, so a retry
   * cannot lose what the second text names; products are then looked up one by one, each outcome stored as it comes, so a retry carries on where
   * this stopped. A model that refuses or rejects the words gives no mentions for that text, and the parse finishes. Anything that may pass
   * (the AI budget, an outage, research under way elsewhere) throws, leaving the row pending for the queue to retry. Logs nothing: the words,
   * brands and names are personal.
   */
  async parse(safetyId: string): Promise<void> {
    const row = await this.repository.find(safetyId)
    if (!row || row.parseState !== 'pending') return
    if ((await this.repository.current(row.profileId))?.id !== row.id) {
      await this.repository.setParseState(row.id, 'done')
      return
    }

    let mentions = await this.repository.mentions(row.id)
    if (mentions.length === 0) {
      mentions = await this.readMentions(row)
      await this.repository.appendMentions(mentions)
    }
    for (const mention of mentions) {
      if (mention.resolution === 'pending') await this.lookUp(mention)
    }
    await this.repository.setParseState(row.id, 'done')
  }

  /** Where the dead-letter queue lands a parse whose retries ran out. The words and the choices still count; a parse that finished stays finished. */
  async markParseFailed(safetyId: string): Promise<void> {
    const row = await this.repository.find(safetyId)
    if (row?.parseState === 'pending') await this.repository.setParseState(row.id, 'failed')
  }

  private async currentRow(): Promise<SafetyRow | null> {
    const { profileId } = requireUser()
    return this.repository.current(profileId)
  }

  /**
   * Seconds to hold a new parse so that the profile parses at most once an hour: until an hour after the newest answer that had words, whatever
   * became of that answer's parse. Answers without words do not count.
   */
  private async parseDelaySeconds(profileId: string, now: Date): Promise<number> {
    const last = (await this.repository.history(profileId)).find((row) => row.reactionText !== null || row.prescriptionText !== null)
    if (!last) return 0
    return Math.max(0, Math.ceil((last.createdAt.getTime() + SafetyService.HOUR_MS - now.getTime()) / 1000))
  }

  /** Queues the parse of a row. A queue that is down is logged by id only and swallowed: the row stays pending and is queued again later. */
  private async queueParse(safetyId: string, delaySeconds: number): Promise<void> {
    try {
      await this.jobs.enqueue(parseSafetySpec, { safetyId }, { delaySeconds })
    } catch {
      console.error({ outcome: 'parse-enqueue-failed', safetyId })
    }
  }

  private async repairParse(row: SafetyRow): Promise<void> {
    if (row.parseState !== 'pending' || row.parseDueAt === null) return
    if (this.now().getTime() - row.parseDueAt.getTime() > SafetyService.OVERDUE_MS) await this.queueParse(row.id, 0)
  }

  /**
   * Reads each text the row has, reaction first, and returns every mention as a row to store, numbered on through the second text. A product the catalog
   * cannot take (it needs a brand and a category) is unresolved at once, and so is any beyond the first three that can be looked up; those three
   * are pending. Ingredients are never looked up, so they have no resolution.
   */
  private async readMentions(row: SafetyRow): Promise<SafetyMentionRow[]> {
    const found: { source: SafetyMentionRow['source']; mention: Mention }[] = []
    for (const [source, field] of SafetyService.SOURCES) {
      const text = row[field]
      if (text === null) continue
      for (const mention of await this.read(text)) found.push({ source, mention })
    }

    let lookUps = SafetyService.MAX_PRODUCTS
    const createdAt = this.now()
    return found.map(({ source, mention }, position): SafetyMentionRow => {
      const base = { id: this.newId(), safetyId: row.id, source, name: mention.name, productId: null, position, createdAt }
      if (mention.kind === 'ingredient') return { ...base, kind: 'ingredient', brand: null, variant: null, category: null, resolution: null }
      const lookUp = mention.brand !== null && mention.category !== null && lookUps > 0
      if (lookUp) lookUps--
      return { ...base, kind: 'product', brand: mention.brand, variant: mention.variant ?? null, category: mention.category, resolution: lookUp ? 'pending' : 'unresolved' }
    })
  }

  /** The reader's mentions for one text. A model that refuses or rejects the words names nothing; any other failure is the job's to retry. */
  private async read(text: string): Promise<Mention[]> {
    try {
      return await this.reader.read(text)
    } catch (error) {
      if (error instanceof AnthropicRefusalError || error instanceof AnthropicRequestError) return []
      throw error
    }
  }

  /**
   * Finds the catalog's product for a mention and, when the catalog has no ingredients for it, researches them (the same two calls a scanned
   * product gets). Resolved means the catalog holds its ingredients; research that finds none is unresolved, keeping the catalog's product, whatever
   * stale list it offers. A budget that is spent throws, as does CatalogBusyError and ResearchInProgressError from the catalog, leaving the mention pending.
   */
  private async lookUp(mention: SafetyMentionRow): Promise<void> {
    const { brand, name, variant, category } = mention
    const resolved = await this.catalog.resolve({ brand: brand!, name, category: category as ProductCategory, ...(variant === null ? {} : { variant }) })
    let resolution: 'resolved' | 'unresolved' = 'resolved'
    if (resolved.kind === 'needs-research') {
      const researched = await this.catalog.research(resolved.productId)
      if (researched.kind === 'budget-exhausted') throw new CatalogBusyError()
      if (researched.kind === 'not-found') resolution = 'unresolved'
    }
    await this.repository.resolveMention(mention.id, { resolution, productId: resolved.productId })
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

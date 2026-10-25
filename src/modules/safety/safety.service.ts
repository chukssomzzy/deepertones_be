import { requireUser } from '../../lib/context'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { normaliseText } from '../../lib/normalise-text'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { AnthropicRefusalError, AnthropicRequestError } from '../../providers/anthropic/anthropic.provider'
import type { JobQueue } from '../../providers/job-queue/job-queue.provider'
import type { Mention, MentionReader } from '../../providers/mention-reading/mention-reader.provider'
import type { ProductCategory } from '../../providers/product-research/product-researcher.provider'
import { CatalogBusyError, type ProductCatalogService } from '../catalog/catalog.service'
import { parseSafetySpec } from './safety.job-specs'
import type { SafetyRepository } from './safety.repository'
import type { MentionSource, ParseState, SafetyMentionRow, SafetyRow, SafetyView } from './safety.types'
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
  private static readonly DAY_MS = 24 * SafetyService.HOUR_MS
  // A parse still pending this long after it was due had its queue message lost; reading the answer queues it again. The queue retries for a good part
  // of an hour (30 s, tripling, up to 10 minutes, 5 attempts) before it gives up, so a parse in its retries is not taken for lost.
  private static readonly OVERDUE_MS = 45 * 60 * 1000
  // The daily sweep queues at most this many due parses, the longest overdue first, so a backlog is worked off over days and never floods the queue.
  private static readonly SWEEP_LIMIT = 200
  // Researching a product is a web search turn, so one answer may research at most this many (ingredients and unbranded things cost nothing).
  private static readonly MAX_PRODUCTS = 3
  private static readonly SOURCES = [
    ['reaction', 'reactionText'],
    ['prescription', 'prescriptionText'],
  ] as const satisfies readonly (readonly [MentionSource, TextField])[]

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
      parseRetried: false,
      createdAt: now,
    }
    await this.repository.append(row)
    if (hasWords) await this.queueParse(row, delaySeconds)
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
   * The given profile's current answers, the state of their parse and the mentions found, all of the one current row, so that what is fingerprinted and what the floor
   * reads are the same answer. By profile id with no session, since a job asks. It only reads: unlike `current` it does not queue a parse that is overdue.
   */
  async snapshotFor(profileId: string): Promise<{ view: SafetyView | null; parseState: ParseState | null; mentions: SafetyMentionRow[] }> {
    const row = await this.repository.current(profileId)
    if (!row) return { view: null, parseState: null, mentions: [] }
    return { view: this.view(row), parseState: row.parseState, mentions: await this.repository.mentions(row.id) }
  }

  /**
   * The background parse of one answer's words, run by the queue as the system actor and safe to run again. A row that does not exist, or is not
   * `pending`, is left alone; one that a newer answer has replaced is finished without a call (the newer one has its own job). Otherwise:
   * each text not yet read is read, and its mentions are stored AS SOON AS they are read, together with the record that the text was read, so a retry
   * never reads a text twice (one that named nothing, or was refused, included) and never loses what an earlier text named. Products are then looked up,
   * each outcome stored as it comes, so a retry carries on where this stopped. A model that refuses or rejects the words names nothing for that text and
   * the parse goes on. Anything that may pass (the AI budget, an outage, research under way elsewhere) throws, leaving the row pending for the queue to
   * retry. Logs nothing: the words, brands and names are personal.
   */
  async parse(safetyId: string): Promise<void> {
    const row = await this.repository.find(safetyId)
    if (!row || row.parseState !== 'pending') return
    if ((await this.repository.current(row.profileId))?.id !== row.id) {
      await this.repository.setParseState(row.id, 'done')
      return
    }

    await this.readTexts(row)
    await this.lookUpPending(await this.repository.mentions(row.id))
    await this.repository.setParseState(row.id, 'done')
  }

  /**
   * Where the dead-letter queue lands a parse whose retries ran out. The first time, the row goes back to pending for one more try the next day (a queue delay
   * cannot reach that far, so it is due at the next midnight UTC and the daily sweep, `requeueDueParses`, queues it); nothing is queued here. The second
   * time is final: failed. The words, the choices and what the parse had found stay as they were, and a parse that finished stays finished.
   */
  async markParseFailed(safetyId: string): Promise<void> {
    const row = await this.repository.find(safetyId)
    if (row?.parseState !== 'pending') return
    if (row.parseRetried) {
      await this.repository.setParseState(row.id, 'failed')
      return
    }
    const now = this.now().getTime()
    await this.repository.retryParseAt(row.id, new Date(Math.floor(now / SafetyService.DAY_MS) * SafetyService.DAY_MS + SafetyService.DAY_MS))
  }

  /**
   * The daily sweep, run by the cron with no session: queues, with no delay, the parse of every pending row whose due time has come (a parse given
   * its second try, or one whose message was lost), the longest overdue first and at most 200 a run. A queue that is down is logged by id only. Answers
   * how many were queued.
   */
  async requeueDueParses(now: Date): Promise<number> {
    let queued = 0
    for (const row of await this.repository.pendingDue(now, SafetyService.SWEEP_LIMIT)) {
      if (await this.queueParse(row, 0)) queued++
    }
    return queued
  }

  private async currentRow(): Promise<SafetyRow | null> {
    const { profileId } = requireUser()
    return this.repository.current(profileId)
  }

  /**
   * Seconds to hold a new parse so that the profile parses at most once an hour: until an hour after the due time of the newest answer with words whose
   * parse is due or has run (due time `now` or earlier). An answer whose parse is still in the future is being replaced by this one, which never lets it
   * run, so it holds nothing back; this answer then falls due at the same hour, and each later one an hour after the last parse that was really due.
   * Answers without words, and rows from before the parse existed (no due time), do not count.
   */
  private async parseDelaySeconds(profileId: string, now: Date): Promise<number> {
    const anchor = (await this.repository.history(profileId)).find(
      (row) => (row.reactionText !== null || row.prescriptionText !== null) && row.parseDueAt !== null && row.parseDueAt.getTime() <= now.getTime(),
    )
    if (!anchor) return 0
    return Math.max(0, Math.ceil((anchor.parseDueAt!.getTime() + SafetyService.HOUR_MS - now.getTime()) / 1000))
  }

  /**
   * Queues the parse of a row; true when it was queued. A row on its second try carries `retry`, whose key is its own (the first run is recorded as failed
   * and would swallow the message). A queue that is down is logged by id only and swallowed: the row stays pending and is queued again later.
   */
  private async queueParse(row: SafetyRow, delaySeconds: number): Promise<boolean> {
    try {
      await this.jobs.enqueue(parseSafetySpec, { safetyId: row.id, ...(row.parseRetried ? { retry: true } : {}) }, { delaySeconds })
      return true
    } catch {
      console.error({ outcome: 'parse-enqueue-failed', safetyId: row.id })
      return false
    }
  }

  private async repairParse(row: SafetyRow): Promise<void> {
    if (row.parseState !== 'pending' || row.parseDueAt === null) return
    if (this.now().getTime() - row.parseDueAt.getTime() > SafetyService.OVERDUE_MS) await this.queueParse(row, 0)
  }

  /**
   * Reads each text of the row that has not been read, reaction first, and stores its mentions at once with the record of the read. The numbering goes on
   * from what is already stored, so it runs through the second text, and so does the limit on products (see `mentionRows`).
   */
  private async readTexts(row: SafetyRow): Promise<void> {
    const done = new Set(await this.repository.reads(row.id))
    for (const [source, field] of SafetyService.SOURCES) {
      const text = row[field]
      if (text === null || done.has(source)) continue
      const mentions = await this.read(text)
      await this.repository.storeRead(row.id, source, this.mentionRows(row, source, mentions, await this.repository.mentions(row.id)))
    }
  }

  /**
   * The mentions one text gave as rows to store, after those `stored` already. A product the catalog cannot take (it needs a brand and a category) is
   * unresolved at once. The others use up the answer's three slots, one for each product however often it is named (the same brand, name and variant, as the
   * catalog compares them, across both texts): a product past the third is unresolved, and a product named again takes the outcome of its first mention, or
   * waits for it. Ingredients are never looked up, so they have no resolution.
   */
  private mentionRows(row: SafetyRow, source: MentionSource, mentions: Mention[], stored: SafetyMentionRow[]): SafetyMentionRow[] {
    // A stored product holds a slot unless it was left over the limit (unresolved, with no catalog product).
    const slots = new Map<string, SafetyMentionRow | null>()
    for (const mention of stored) {
      const key = SafetyService.productKey(mention)
      if (key !== null && (mention.resolution !== 'unresolved' || mention.productId !== null)) slots.set(key, slots.get(key) ?? mention)
    }
    const createdAt = this.now()
    return mentions.map((mention, index): SafetyMentionRow => {
      const base = { id: this.newId(), safetyId: row.id, source, name: mention.name, productId: null, position: stored.length + index, createdAt }
      if (mention.kind === 'ingredient') return { ...base, kind: 'ingredient', brand: null, variant: null, category: null, resolution: null }
      const product = { ...base, kind: 'product' as const, brand: mention.brand, variant: mention.variant ?? null, category: mention.category }
      const key = SafetyService.productKey(product)
      if (key === null) return { ...product, resolution: 'unresolved' }
      if (!slots.has(key) && slots.size >= SafetyService.MAX_PRODUCTS) return { ...product, resolution: 'unresolved' }
      const first = slots.get(key)
      if (first && first.resolution !== 'pending') return { ...product, resolution: first.resolution, productId: first.productId }
      if (!slots.has(key)) slots.set(key, null)
      return { ...product, resolution: 'pending' }
    })
  }

  /** What makes two mentions one product, as the catalog compares them (case, accents and punctuation aside); null for one it cannot take (no brand or category). */
  private static productKey(mention: Pick<SafetyMentionRow, 'kind' | 'brand' | 'name' | 'variant' | 'category'>): string | null {
    if (mention.kind !== 'product' || mention.brand === null || mention.category === null) return null
    return [mention.brand, mention.name, mention.variant ?? ''].map(normaliseText).join('|')
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

  /** Looks up every pending product, once for each product however often it is named, and gives all its mentions the outcome. */
  private async lookUpPending(mentions: SafetyMentionRow[]): Promise<void> {
    const groups = new Map<string, SafetyMentionRow[]>()
    for (const mention of mentions) {
      const key = mention.resolution === 'pending' ? SafetyService.productKey(mention) : null
      if (key !== null) groups.set(key, [...(groups.get(key) ?? []), mention])
    }
    for (const group of groups.values()) await this.lookUp(group)
  }

  /**
   * Finds the catalog's product for a mention and, when the catalog has no ingredients for it, researches them (the same two calls a scanned
   * product gets). Resolved means the catalog holds its ingredients; research that finds none is unresolved, keeping the catalog's product, whatever
   * stale list it offers. A budget that is spent throws, as does CatalogBusyError and ResearchInProgressError from the catalog, leaving the mentions pending.
   */
  private async lookUp(mentions: SafetyMentionRow[]): Promise<void> {
    const { brand, name, variant, category } = mentions[0]!
    const resolved = await this.catalog.resolve({ brand: brand!, name, category: category as ProductCategory, ...(variant === null ? {} : { variant }) })
    let resolution: 'resolved' | 'unresolved' = 'resolved'
    if (resolved.kind === 'needs-research') {
      const researched = await this.catalog.research(resolved.productId)
      if (researched.kind === 'budget-exhausted') throw new CatalogBusyError()
      if (researched.kind === 'not-found') resolution = 'unresolved'
    }
    for (const mention of mentions) await this.repository.resolveMention(mention.id, { resolution, productId: resolved.productId })
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

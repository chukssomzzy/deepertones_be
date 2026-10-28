import { requireUser } from '../../lib/context'
import { ForbiddenError, NotFoundError } from '../../lib/errors'
import { FORBIDDEN_WORDING } from '../routines/routines.wording'
import type { InboxRepository } from './inbox.repository'
import type { InboxItem } from './inbox.types'

export type InboxServiceDeps = {
  repository: InboxRepository
  now?: () => Date
  newId?: () => string
}

/** A row as the app sees it: no key, no profile id and no read time. */
export type InboxItemView = { id: string; kind: string; day: string; title: string; body: string; link: string; read: boolean; createdAt: Date }

/** What `write` takes: the row's event and its copy, by profile id. */
export type InboxWrite = { profileId: string; kind: string; day: string; title: string; body: string; link: string; key: string }

/**
 * The profile's inbox (spec #233): what the routine says about itself, kept for good. Other services and the 15-minute job write by profile id with no session
 * (`write`, `markReadById`, `summaryFor`); the profile's own reads go through the session (`list`, `markRead`). Every row has a key, so a write that repeats
 * (a job that runs twice, a retried event) makes one row.
 */
export class InboxService {
  private static readonly DEFAULT_LIMIT = 20
  private static readonly MAX_LIMIT = 50
  private static readonly SUMMARY_SIZE = 5

  private readonly repository: InboxRepository
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(deps: InboxServiceDeps) {
    this.repository = deps.repository
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Writes the row unless the profile already holds the key, and answers the holder's id with `created` false when it does (the first row stays as it was, whatever the
   * second call carries). Throws, and writes nothing, for a title or body that fails FORBIDDEN_WORDING or a link that is not an in-app path ('/...'): a line that
   * breaks the wording rules is a bug in the writer, never something to show a person. The key is not used up by a refusal.
   */
  async write(input: InboxWrite): Promise<{ id: string; created: boolean }> {
    InboxService.checked(input)
    return this.repository.insertOnce({
      id: this.newId(),
      profileId: input.profileId,
      kind: input.kind,
      localDay: input.day,
      title: input.title,
      body: input.body,
      link: input.link,
      key: input.key,
      createdAt: this.now(),
    })
  }

  /**
   * The session profile's rows, newest first, `limit` at a time (20 by default, at most 50). `before` is the `next` of the page before; `next` is non-null when more
   * rows follow. 401 with no session, 403 `SIGNUP_REQUIRED` for a guest, 404 `INBOX_ITEM_NOT_FOUND` for a `before` that is no row of the profile's.
   */
  async list(query: { before?: string; limit?: number }): Promise<{ items: InboxItemView[]; next: string | null }> {
    const { profileId } = InboxService.signedUp()
    const limit = Math.min(query.limit ?? InboxService.DEFAULT_LIMIT, InboxService.MAX_LIMIT)
    const before = query.before === undefined ? undefined : await this.held(profileId, query.before)
    // One row more than the page tells whether anything follows it.
    const rows = await this.repository.list(profileId, { before: before && { createdAt: before.createdAt, id: before.id }, limit: limit + 1 })
    const page = rows.slice(0, limit)
    return { items: page.map(InboxService.viewOf), next: rows.length > limit ? page[page.length - 1]!.id : null }
  }

  /**
   * Marks the row `upTo` and every unread row created at or before it read, and answers the profile's unread count after. Idempotent; a row already read keeps its time.
   * 401, 403 `SIGNUP_REQUIRED`, and 404 `INBOX_ITEM_NOT_FOUND` for a row the profile does not hold (nothing is marked).
   */
  async markRead(upTo: string): Promise<{ unread: number }> {
    const { profileId } = InboxService.signedUp()
    const row = await this.held(profileId, upTo)
    await this.repository.markReadUpTo(profileId, row.createdAt, this.now())
    return { unread: await this.repository.unreadCount(profileId) }
  }

  /** Marks that one row read, by profile id with no session (a push tap). An id the profile does not hold changes nothing and does not fail. */
  async markReadById(profileId: string, id: string): Promise<void> {
    await this.repository.markRead(profileId, id, this.now())
  }

  /** The profile's unread count and its 5 newest rows, read or not, by profile id with no session (Today reads it). */
  async summaryFor(profileId: string): Promise<{ unread: number; latest: InboxItemView[] }> {
    const [unread, latest] = await Promise.all([this.repository.unreadCount(profileId), this.repository.list(profileId, { limit: InboxService.SUMMARY_SIZE })])
    return { unread, latest: latest.map(InboxService.viewOf) }
  }

  private async held(profileId: string, id: string): Promise<InboxItem> {
    const row = await this.repository.find(profileId, id)
    if (row === null) throw new NotFoundError('INBOX_ITEM_NOT_FOUND', 'That inbox item was not found')
    return row
  }

  private static signedUp() {
    const user = requireUser()
    if (user.status !== 'verified') throw new ForbiddenError('SIGNUP_REQUIRED', 'Sign up to see your inbox')
    return user
  }

  /** The error names the row's key, never its text: the text is what failed. */
  private static checked({ title, body, link, key }: InboxWrite) {
    if ([title, body].some((text) => FORBIDDEN_WORDING.some(({ pattern }) => pattern.test(text)))) throw new Error(`Inbox row ${key} fails the wording gate`)
    // An in-app path: one leading slash, never '//host' or a backslash, which a URL opener could take off the app.
    if (!link.startsWith('/') || link.startsWith('//') || link.includes('\\')) throw new Error(`Inbox row ${key} must link to an in-app path`)
  }

  private static viewOf({ id, kind, localDay, title, body, link, readAt, createdAt }: InboxItem): InboxItemView {
    return { id, kind, day: localDay, title, body, link, read: readAt !== null, createdAt }
  }
}

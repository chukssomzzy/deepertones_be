import type { ReminderSendsRepository } from './reminders.sends.repository'

/** In-memory ReminderSendsRepository for unit tests. Its behaviour is pinned by reminderSendsRepositoryContract, which the D1 class also passes. It does not model the foreign key to profiles; D1 does (see test/integration). */
export class FakeReminderSendsRepository implements ReminderSendsRepository {
  private claims = new Map<string, Date>()

  /** Holds the key and says true unless it was held already. */
  async claim(profileId: string, localDay: string, kind: string, at: Date): Promise<boolean> {
    const key = JSON.stringify([profileId, localDay, kind])
    if (this.claims.has(key)) return false
    this.claims.set(key, at)
    return true
  }
}

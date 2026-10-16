import { and, asc, desc, eq } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'
import { profiles } from './profiles.table'
import type { Profile } from './profiles.types'

export class D1ProfilesRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<Profile | null> {
    const [row] = await this.db.select().from(profiles).where(eq(profiles.id, id))
    return row ?? null
  }

  async defaultFor(userId: string): Promise<Profile | null> {
    const [row] = await this.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.userId, userId), eq(profiles.isDefault, true)))
    return row ?? null
  }

  /** The user's profiles: the default first, then the others oldest first. */
  async ofUser(userId: string): Promise<Profile[]> {
    return this.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .orderBy(desc(profiles.isDefault), asc(profiles.createdAt))
  }

  /** Rejects an id that is taken, and a second default for the same user. The default of a new guest is written by the users repository instead, in the guest's own batch. */
  async insert(profile: Profile): Promise<void> {
    await this.db.insert(profiles).values(profile)
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type ProfilesRepository = PublicOf<D1ProfilesRepository>

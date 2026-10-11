import { sql } from 'drizzle-orm'
import type { Db } from '../../lib/db'
import type { PublicOf } from '../../lib/types'

export class D1HealthRepository {
  constructor(private readonly db: Db) {}

  /** Resolves if the database answers a trivial query; rejects otherwise. */
  async ping(): Promise<void> {
    await this.db.run(sql`select 1`)
  }
}

// The D1 class is the source of truth; services and fakes use this type.
export type HealthRepository = PublicOf<D1HealthRepository>

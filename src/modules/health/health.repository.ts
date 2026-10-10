import { sql } from 'drizzle-orm'
import type { Db } from '../../lib/db'

export interface HealthRepository {
  /** Resolves if the database answers a trivial query; rejects otherwise. */
  ping(): Promise<void>
}

export class D1HealthRepository implements HealthRepository {
  constructor(private readonly db: Db) {}

  async ping(): Promise<void> {
    await this.db.run(sql`select 1`)
  }
}

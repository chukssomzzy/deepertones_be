import { drizzle } from 'drizzle-orm/d1'

/**
 * The Drizzle client every repository receives through its constructor.
 * Built once per request by the container; only repositories may import drizzle-orm.
 *
 * D1 has no interactive transactions. When writes must succeed or fail together,
 * put them in ONE repository method and run them with `db.batch([...])`.
 */
export const createDb = (d1: D1Database) => drizzle(d1)

export type Db = ReturnType<typeof createDb>

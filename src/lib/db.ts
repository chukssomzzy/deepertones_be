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

// D1 allows 100 bound parameters per statement; this many ids leave headroom.
export const ID_CHUNK = 90

export const chunked = <T>(items: T[], size = ID_CHUNK): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Runs a lookup that binds one parameter per id once per chunk of ids and joins the rows, so no statement binds more than D1 allows. */
export const queryByIds = async <Row>(ids: string[], run: (chunk: string[]) => Promise<Row[]>): Promise<Row[]> => {
  const found: Row[] = []
  for (const chunk of chunked(ids)) found.push(...(await run(chunk)))
  return found
}

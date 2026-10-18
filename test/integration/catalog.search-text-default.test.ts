import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'

// The migration that adds products.search_text only adds the column; the catalog service fills it in code (fillSearchText), because SQL
// cannot normalise the way normaliseText does. Between the migration and the new Worker going live the OLD Worker keeps creating products
// with an INSERT that does not know the column, so that INSERT has to keep working and leave the text empty for the service to fill.

const NOW = Date.now()
const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0

describe('the products.search_text column', () => {
  it('lets an INSERT that does not name it succeed, and reads back as an empty search text that search does not find', async () => {
    const w = `dflt${runSalt}n${counter++}z`
    const id = crypto.randomUUID()

    await env.DB.prepare('INSERT INTO products (id, identity_key, brand_key, kind, brand, name, variant, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, `${w}|baby oil|`, w, 'named', w, 'Baby Oil', null, 'body', NOW)
      .run()

    const repo = new D1CatalogRepository(createDb(env.DB))
    expect(await repo.findProductById(id)).toMatchObject({ id, searchText: '' })
    expect(await repo.search(w, 10)).toEqual([])
  })
})

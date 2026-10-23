import { describe, expect, it } from 'vitest'
import { catalogDrafterDraftCatalogRowPrompt } from '../../prompts/prompts.generated'
import { AI_JOBS, AiBudgetExceededError, type AiJob } from '../anthropic/ai-spend.provider'
import { AnthropicClient } from '../anthropic/anthropic.client'
import { AnthropicRefusalError, AnthropicRequestError } from '../anthropic/anthropic.provider'
import { MemoryAiSpendLedger } from '../anthropic/memory.ai-spend-ledger'
import {
  API_KEY,
  BIG_CAP_MICROS,
  type Block,
  caught,
  MODEL,
  MODELS,
  messageResponse,
  requestText,
  searchCall,
  searchResults,
  stubFetch,
  textBlock,
} from '../anthropic/messages-api.fake'
import { AnthropicCatalogDrafter } from './anthropic.catalog-drafter'
import type { DraftRequest } from './catalog-drafter.provider'

const ROUTED_TO = 'claude-haiku-5-5'
const DRAFT_CATALOG_ROW: AiJob = 'draft-catalog-row'

// Pages the search returns in these tests. INVENTED is a page the model names without ever having seen it.
const BRAND_PAGE = 'https://www.cerave.example/products/hydrating-cleanser'
const RETAILER_PAGE = 'https://www.retailer.example/p/cerave-hydrating-cleanser'
const INVENTED_PAGE = 'https://www.invented.example/made-up-page'

const REQUEST: DraftRequest = {
  product: { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: 'Normal to Dry Skin', category: 'skin' },
  columns: ['skin_concerns', 'skin_types', 'steps', 'frequency'],
  countries: [
    { code: 'NG', currency: 'NGN' },
    { code: 'GB', currency: 'GBP' },
  ],
}

// Written out, not read from the code under test: the values a drafted cell may hold (decision 4 of the plan).
const CONCERN_IDS = ['hd_acne', 'hd_pore', 'hd_oiliness', 'hd_age_spot', 'hd_redness', 'hd_radiance', 'hd_texture', 'hd_dark_circle', 'hd_moisture']
const SKIN_TYPES = ['oily', 'dry', 'combination', 'normal', 'all']
const STEPS = ['cleanse', 'treat', 'moisturise', 'protect']
const FREQUENCY_VALUES = ['am', 'pm', 'am-pm', 'alternate-days', 'weekly', 'as-needed']

/** What the model's final message says: the same shape the adapter returns, before it is checked. */
const answer = (over: Record<string, unknown> = {}) => ({
  cells: {
    skin_concerns: { value: ['hd_moisture', 'hd_redness'], sourceUrl: BRAND_PAGE },
    skin_types: { value: ['dry', 'combination'], sourceUrl: BRAND_PAGE },
    steps: { value: ['cleanse'], sourceUrl: RETAILER_PAGE },
    frequency: { value: 'am-pm', sourceUrl: RETAILER_PAGE },
  },
  availability: [
    { country: 'NG', priceMin: 4000, priceMax: 6500, whereSold: 'Pharmacies and online', sourceUrl: BRAND_PAGE },
    { country: 'GB', priceMin: 9, priceMax: 12, whereSold: null, sourceUrl: RETAILER_PAGE },
  ],
  ...over,
})
/** An answer with only the given cells. */
const cellsOf = (cells: Record<string, unknown>) => answer({ cells, availability: [] })
/** An answer with only the given availability rows. */
const rowsOf = (...rows: Record<string, unknown>[]) => answer({ cells: {}, availability: rows })
const row = (over: Record<string, unknown> = {}) => ({ country: 'NG', priceMin: 4000, priceMax: 6500, whereSold: 'Pharmacies and online', sourceUrl: BRAND_PAGE, ...over })

/** A completed web-search turn that ends with `finalText`; the search returned BRAND_PAGE and RETAILER_PAGE (or `urls`). */
const searched = (finalText: string, urls = [BRAND_PAGE, RETAILER_PAGE]): Block[] => [
  textBlock('Let me look that up.'),
  searchCall('srvtoolu_01', 'CeraVe Hydrating Facial Cleanser price'),
  searchResults('srvtoolu_01', urls),
  textBlock(finalText),
]

const respondWith = (content: Block[], stop_reason = 'end_turn') => () => messageResponse({ content, stop_reason })

/** Every job on MODEL, except `routed`, which goes to ROUTED_TO: whichever job the adapter uses shows in the model it sends. */
const drafterWith = (fetch: typeof globalThis.fetch, ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS }), routed?: AiJob) =>
  new AnthropicCatalogDrafter(
    new AnthropicClient({
      apiKey: API_KEY,
      models: { ...MODELS, ...(routed ? { [routed]: ROUTED_TO } : {}) },
      ledger,
      baseURL: 'https://anthropic.example',
      fetch,
    }),
  )

const drafterOver = (...responders: Parameters<typeof stubFetch>) => {
  const { calls, fetch } = stubFetch(...responders)
  return { calls, drafter: drafterWith(fetch) }
}

const draft = async (content: Block[], request: DraftRequest = REQUEST) => drafterOver(respondWith(content)).drafter.draft(request)
/** The result for a model that searched and then said `value`. */
const draftFrom = (value: unknown, request: DraftRequest = REQUEST, urls?: string[]) => draft(searched(JSON.stringify(value), urls), request)

describe('the draft-catalog-row AI job', () => {
  it('is one of the jobs the AI spend ledger and the client know', () => {
    expect(AI_JOBS).toContain('draft-catalog-row')
  })

  it('is the job the catalog drafter prompt runs under', () => {
    expect(catalogDrafterDraftCatalogRowPrompt.job).toBe('draft-catalog-row')
  })
})

describe('AnthropicCatalogDrafter job routing and cost', () => {
  it('asks Claude as the draft-catalog-row job and uses the model configured for it', async () => {
    const { calls, fetch } = stubFetch(respondWith(searched(JSON.stringify(answer()))))

    await drafterWith(fetch, undefined, DRAFT_CATALOG_ROW).draft(REQUEST)

    expect(calls[0]!.body.model).toBe(ROUTED_TO)
  })

  it('does not use the model of any other job', async () => {
    const { calls, fetch } = stubFetch(respondWith(searched(JSON.stringify(answer()))))
    const others = AI_JOBS.filter((job) => job !== 'draft-catalog-row')

    for (const other of others) await drafterWith(fetch, undefined, other).draft(REQUEST)

    expect(calls.map((c) => c.body.model)).toEqual(others.map(() => MODEL))
  })

  it('records its call on the ledger under the draft-catalog-row job', async () => {
    const { fetch } = stubFetch(respondWith(searched(JSON.stringify(answer()))))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await drafterWith(fetch, ledger).draft(REQUEST)

    expect(ledger.entries.map((e) => [e.job, e.model, e.status])).toEqual([['draft-catalog-row', MODEL, 'settled']])
  })

  it('reserves room for every search the request allows, on top of the tokens', async () => {
    const { calls, fetch } = stubFetch(respondWith(searched(JSON.stringify(answer()))))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await drafterWith(fetch, ledger).draft(REQUEST)

    // A search is 10000 micros; the reservation must hold at least all the searches the request permits.
    const maxUses = calls[0]!.body.tools[0].max_uses
    expect(maxUses).toBeGreaterThanOrEqual(1)
    expect(ledger.entries[0]!.estimateMicros).toBeGreaterThanOrEqual(maxUses * 10_000)
  })

  it('throws AiBudgetExceededError, sending nothing, when the spend cap would be passed, so the caller can stop cleanly', async () => {
    const { calls, fetch } = stubFetch(respondWith(searched(JSON.stringify(answer()))))

    const error = await caught(drafterWith(fetch, new MemoryAiSpendLedger({ capMicros: 1 })).draft(REQUEST))

    expect(error).toBeInstanceOf(AiBudgetExceededError)
    expect(calls).toHaveLength(0)
  })
})

describe('AnthropicCatalogDrafter request', () => {
  it('lets the model search the web, since a value without a page to cite is dropped', async () => {
    const { calls, drafter } = drafterOver(respondWith(searched(JSON.stringify(answer()))))

    await drafter.draft(REQUEST)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.tools).toEqual([expect.objectContaining({ name: 'web_search', type: expect.stringMatching(/^web_search/) })])
  })

  it('tells the model which product, which columns and which countries', async () => {
    const { calls, drafter } = drafterOver(respondWith(searched(JSON.stringify(answer()))))

    await drafter.draft({ ...REQUEST, columns: ['frequency', 'steps'], countries: [{ code: 'GH', currency: 'GHS' }] })

    const sent = requestText(calls[0]!.body)
    for (const word of ['CeraVe', 'Hydrating Facial Cleanser', 'Normal to Dry Skin', 'frequency', 'steps', 'GH', 'GHS']) expect(sent).toContain(word)
  })

  it('tells the model every value it may use, so an answer can sit in the vocabularies', async () => {
    const { calls, drafter } = drafterOver(respondWith(searched(JSON.stringify(answer()))))

    await drafter.draft(REQUEST)

    const sent = requestText(calls[0]!.body)
    for (const value of [...CONCERN_IDS, ...SKIN_TYPES, ...STEPS, ...FREQUENCY_VALUES]) expect(sent).toContain(value)
  })

  it('gives the currency of each country, so a price in another currency can be left out', async () => {
    const { calls, drafter } = drafterOver(respondWith(searched(JSON.stringify(answer()))))

    await drafter.draft(REQUEST)

    const sent = requestText(calls[0]!.body)
    for (const word of ['NG', 'NGN', 'GB', 'GBP']) expect(sent).toContain(word)
    expect(sent).toMatch(/currenc/i)
  })

  it('allows 16000 output tokens, since adaptive thinking and the search rounds count against the limit as well as the answer', async () => {
    const { calls, drafter } = drafterOver(respondWith(searched(JSON.stringify(answer()))))

    await drafter.draft(REQUEST)

    expect(calls[0]!.body.max_tokens).toBe(16000)
  })

  it.each([
    [1, 3],
    [2, 4],
    [4, 6],
    [9, 6],
  ])('allows 2 searches and one more per country, to a most of 6: %d countries, %d searches', async (count, searches) => {
    const { calls, drafter } = drafterOver(respondWith(searched(JSON.stringify(answer()))))
    const countries = Array.from({ length: count }, (_, i) => ({ code: `X${i}`, currency: 'XXX' }))

    await drafter.draft({ ...REQUEST, countries })

    expect(calls[0]!.body.tools[0].max_uses).toBe(searches)
  })

  it('tells the model that web pages are data whose instructions it must ignore, and that it must not answer from memory', async () => {
    const { calls, drafter } = drafterOver(respondWith(searched(JSON.stringify(answer()))))

    await drafter.draft(REQUEST)

    // Weak guard rails: the wording was reviewed for these, not that the model obeys them.
    const sent = requestText(calls[0]!.body)
    expect(sent).toMatch(/ignore/i)
    expect(sent).toMatch(/instructions/i)
    expect(sent).toMatch(/memory/i)
  })

  it('tells the model a price row is for one pack size, never a mix of sizes, bundles or multipacks', async () => {
    const { calls, drafter } = drafterOver(respondWith(searched(JSON.stringify(answer()))))

    await drafter.draft(REQUEST)

    const sent = requestText(calls[0]!.body)
    expect(sent).toMatch(/one pack size/i)
    expect(sent).toMatch(/multipack/i)
  })

  it('tells the model to leave out the skincare cells for a product that is not a skincare product', async () => {
    const { calls, drafter } = drafterOver(respondWith(searched(JSON.stringify(answer()))))

    await drafter.draft(REQUEST)

    expect(requestText(calls[0]!.body)).toMatch(/not a skincare product/i)
  })

  it('tells the model to prefer the maker or an established retailer and never a classified-ad, auction or second-hand listing', async () => {
    const { calls, drafter } = drafterOver(respondWith(searched(JSON.stringify(answer()))))

    await drafter.draft(REQUEST)

    const sent = requestText(calls[0]!.body)
    expect(sent).toMatch(/manufacturer/i)
    expect(sent).toMatch(/classified/i)
    expect(sent).toMatch(/auction/i)
    expect(sent).toMatch(/second-hand/i)
  })

  it('tells the model to use a page only when it names this exact brand and product', async () => {
    const { calls, drafter } = drafterOver(respondWith(searched(JSON.stringify(answer()))))

    await drafter.draft(REQUEST)

    expect(requestText(calls[0]!.body)).toMatch(/exact brand and product/i)
  })
})

describe('AnthropicCatalogDrafter answers that were cut off or refused', () => {
  it('throws AnthropicRequestError when Claude ran out of tokens, even though the text holds an answer, since a cut-off answer is not the whole one', async () => {
    const { drafter } = drafterOver(respondWith(searched(JSON.stringify(answer())), 'max_tokens'))

    await expect(drafter.draft(REQUEST)).rejects.toBeInstanceOf(AnthropicRequestError)
  })

  it('throws AnthropicRefusalError when Claude refused', async () => {
    const { drafter } = drafterOver(respondWith([textBlock('I cannot help with that.')], 'refusal'))

    await expect(drafter.draft(REQUEST)).rejects.toBeInstanceOf(AnthropicRefusalError)
  })
})

describe('AnthropicCatalogDrafter.draft', () => {
  it('returns every drafted cell with its value and the page it came from, and an availability row for each country', async () => {
    const result = await draftFrom(answer())

    expect(result).toEqual({
      cells: {
        skin_concerns: { value: ['hd_moisture', 'hd_redness'], sourceUrl: BRAND_PAGE },
        skin_types: { value: ['dry', 'combination'], sourceUrl: BRAND_PAGE },
        steps: { value: ['cleanse'], sourceUrl: RETAILER_PAGE },
        frequency: { value: 'am-pm', sourceUrl: RETAILER_PAGE },
      },
      availability: [
        { country: 'NG', priceMin: 4000, priceMax: 6500, whereSold: 'Pharmacies and online', sourceUrl: BRAND_PAGE },
        { country: 'GB', priceMin: 9, priceMax: 12, sourceUrl: RETAILER_PAGE },
      ],
    })
  })

  it('finds the JSON inside a json code fence with prose around it', async () => {
    const text = `Here is what I found:\n\`\`\`json\n${JSON.stringify(answer())}\n\`\`\`\nHope that helps.`

    const result = await draft(searched(text))

    expect(result.cells.frequency).toEqual({ value: 'am-pm', sourceUrl: RETAILER_PAGE })
    expect(result.availability).toHaveLength(2)
  })

  it('leaves out a column the model could not find, whether it says null or leaves it out', async () => {
    const result = await draftFrom(cellsOf({ skin_concerns: null, skin_types: { value: ['dry'], sourceUrl: BRAND_PAGE } }))

    expect(result.cells).toEqual({ skin_types: { value: ['dry'], sourceUrl: BRAND_PAGE } })
  })

  it('returns only the columns that were asked for, even when the model volunteers others', async () => {
    const result = await draftFrom(answer(), { ...REQUEST, columns: ['frequency'] })

    expect(Object.keys(result.cells)).toEqual(['frequency'])
  })

  it('returns only the countries that were asked for, even when the model volunteers others', async () => {
    const result = await draftFrom(
      rowsOf(row({ country: 'NG' }), row({ country: 'GB', priceMin: 9, priceMax: 12 }), row({ country: 'US', priceMin: 9, priceMax: 12 })),
      { ...REQUEST, countries: [{ code: 'GB', currency: 'GBP' }] },
    )

    expect(result.availability.map((r) => r.country)).toEqual(['GB'])
  })

  describe('values outside the vocabularies', () => {
    it('drops a list item that is not in the vocabulary and keeps the rest, in order', async () => {
      const result = await draftFrom(cellsOf({ skin_concerns: { value: ['hd_redness', 'glowy', 'hd_acne'], sourceUrl: BRAND_PAGE } }))

      expect(result.cells.skin_concerns).toEqual({ value: ['hd_redness', 'hd_acne'], sourceUrl: BRAND_PAGE })
    })

    it('keeps an item once however many times the model repeats it', async () => {
      const result = await draftFrom(cellsOf({ steps: { value: ['cleanse', 'treat', 'cleanse'], sourceUrl: BRAND_PAGE } }))

      expect(result.cells.steps).toEqual({ value: ['cleanse', 'treat'], sourceUrl: BRAND_PAGE })
    })

    it.each([
      ['skin_concerns', ['acne', 'glowy']],
      ['skin_types', ['dehydrated']],
      ['steps', ['exfoliate']],
      ['skin_concerns', []],
    ])('leaves out %s when none of %j is in the vocabulary', async (column, value) => {
      const result = await draftFrom(cellsOf({ [column]: { value, sourceUrl: BRAND_PAGE } }))

      expect(result.cells).toEqual({})
    })

    it.each([['daily'], ['AM'], ['am-pm-am'], [''], ['am; pm']])('leaves out a frequency of %j', async (frequency) => {
      const result = await draftFrom(cellsOf({ frequency: { value: frequency, sourceUrl: BRAND_PAGE } }))

      expect(result.cells).toEqual({})
    })

    it.each(FREQUENCY_VALUES)('accepts the frequency %s', async (frequency) => {
      const result = await draftFrom(cellsOf({ frequency: { value: frequency, sourceUrl: BRAND_PAGE } }))

      expect(result.cells.frequency).toEqual({ value: frequency, sourceUrl: BRAND_PAGE })
    })

    it('accepts "all" on its own as the skin type', async () => {
      const result = await draftFrom(cellsOf({ skin_types: { value: ['all'], sourceUrl: BRAND_PAGE } }))

      expect(result.cells.skin_types).toEqual({ value: ['all'], sourceUrl: BRAND_PAGE })
    })

    it('leaves out a skin type that lists "all" next to another type, since the workbook would refuse it', async () => {
      const result = await draftFrom(cellsOf({ skin_types: { value: ['all', 'oily'], sourceUrl: BRAND_PAGE } }))

      expect(result.cells).toEqual({})
    })

    it('leaves out a column whose value is the wrong kind of thing', async () => {
      const result = await draftFrom(cellsOf({ skin_concerns: { value: 'hd_acne', sourceUrl: BRAND_PAGE }, frequency: { value: ['am'], sourceUrl: BRAND_PAGE } }))

      expect(result.cells).toEqual({})
    })
  })

  describe('sources', () => {
    // Every case names a value that is in the vocabulary, so the source is the only thing that can be wrong.
    it.each([
      ['a page the search never returned', INVENTED_PAGE, [BRAND_PAGE, RETAILER_PAGE]],
      ['a page that is not https, even though the search returned it', 'http://www.cerave.example/p', ['http://www.cerave.example/p']],
      ['an address on a private network, even though the search returned it', 'https://192.168.0.1/p', ['https://192.168.0.1/p']],
      ['a page on localhost, even though the search returned it', 'https://localhost/p', ['https://localhost/p']],
      ['a page whose address holds a semicolon, which would split a draft_cells entry', 'https://www.cerave.example/p;x', ['https://www.cerave.example/p;x']],
      ['no source', null, [BRAND_PAGE]],
      ['an empty source', '', [BRAND_PAGE]],
      ['a source that is not a string', 42, [BRAND_PAGE]],
    ])('leaves out a cell whose source is %s', async (_label, sourceUrl, returned) => {
      const result = await draftFrom(cellsOf({ frequency: { value: 'pm', sourceUrl }, steps: { value: ['cleanse'], sourceUrl: BRAND_PAGE } }), REQUEST, returned as string[])

      expect(Object.keys(result.cells)).not.toContain('frequency')
    })

    it('leaves out a cell with no source object at all', async () => {
      const result = await draftFrom(cellsOf({ frequency: { value: 'pm' } }))

      expect(result.cells).toEqual({})
    })

    it('keeps a cell whose source is a page the search returned, even when the answer text cites nothing', async () => {
      const result = await draftFrom(cellsOf({ frequency: { value: 'pm', sourceUrl: RETAILER_PAGE } }))

      expect(result.cells.frequency).toEqual({ value: 'pm', sourceUrl: RETAILER_PAGE })
    })

    it('keeps every other cell when one has a bad source', async () => {
      const result = await draftFrom(cellsOf({ frequency: { value: 'pm', sourceUrl: INVENTED_PAGE }, steps: { value: ['cleanse'], sourceUrl: BRAND_PAGE } }))

      expect(result.cells).toEqual({ steps: { value: ['cleanse'], sourceUrl: BRAND_PAGE } })
    })

    it.each([
      'https://www.ebay.com/itm/1',
      'https://www.ebay.co.uk/itm/1',
      'https://EBAY.de/itm/1',
      'https://jiji.ng/lagos/health/1',
      'https://www.jiji.com.ng/health/1',
      'https://craigslist.org/p/1',
      'https://lagos.craigslist.org/p/1',
      'https://www.gumtree.com/p/1',
      'https://www.gumtree.com.au/p/1',
      'https://olx.pl/p/1',
      'https://www.olx.com.ng/p/1',
    ])('leaves out a cell and a price row sourced from the classified or auction site %s, even though the search returned it', async (listing) => {
      const result = await draftFrom(
        answer({
          cells: { frequency: { value: 'pm', sourceUrl: listing }, steps: { value: ['cleanse'], sourceUrl: BRAND_PAGE } },
          availability: [row({ sourceUrl: listing })],
        }),
        REQUEST,
        [BRAND_PAGE, listing],
      )

      expect(result.cells).toEqual({ steps: { value: ['cleanse'], sourceUrl: BRAND_PAGE } })
      expect(result.availability).toEqual([])
    })

    it.each([
      'https://www.jumia.com.ng/p/1',
      'https://www.amazon.com/dp/1',
      'https://notebay.com/p/1',
      'https://ebay-shop.example/p/1',
      'https://shop.example/ebay',
      'https://olx.shop.example/p/1',
    ])('keeps a source on %s, since only the classified and auction sites are refused', async (page) => {
      const result = await draftFrom(cellsOf({ frequency: { value: 'pm', sourceUrl: page } }), REQUEST, [page])

      expect(result.cells.frequency).toEqual({ value: 'pm', sourceUrl: page })
    })

    it('never invents: an answer from a model that did not search has no value, whatever pages it names', async () => {
      const result = await draft([textBlock(JSON.stringify(answer()))])

      expect(result).toEqual({ cells: {}, availability: [] })
    })

    it('never invents: an answer after a failed search has no value', async () => {
      const failed: Block[] = [
        searchCall('srvtoolu_01', 'q'),
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_01', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } },
        textBlock(JSON.stringify(answer())),
      ]

      const result = await draft(failed)

      expect(result).toEqual({ cells: {}, availability: [] })
    })
  })

  describe('availability rows', () => {
    it.each([
      ['a country that was not asked for', row({ country: 'US' })],
      ['a lowest price above the highest', row({ priceMin: 6501, priceMax: 6500 })],
      ['a negative price', row({ priceMin: -1, priceMax: 6500 })],
      ['a price with a fraction', row({ priceMin: 4000.5 })],
      ['a price written as text', row({ priceMin: '4000' })],
      ['no price', row({ priceMax: null })],
      ['a price of 0, which no source gives', row({ priceMin: 0, priceMax: 0 })],
      ['a price beyond what a whole number can hold exactly', row({ priceMax: 2 ** 53 })],
      ['a page the search never returned as its source', row({ sourceUrl: INVENTED_PAGE })],
      ['a source that is not https', row({ sourceUrl: 'http://www.cerave.example/p' })],
      ['no source', row({ sourceUrl: null })],
    ])('drops a row with %s', async (_label, bad) => {
      const result = await draftFrom(rowsOf(bad), REQUEST, [BRAND_PAGE, RETAILER_PAGE, 'http://www.cerave.example/p'])

      expect(result.availability).toEqual([])
    })

    it('keeps the good rows when one is dropped', async () => {
      const result = await draftFrom(rowsOf(row({ country: 'NG', sourceUrl: INVENTED_PAGE }), row({ country: 'GB', priceMin: 9, priceMax: 12 })))

      expect(result.availability.map((r) => r.country)).toEqual(['GB'])
    })

    it('keeps one row for a country the model lists twice: the first', async () => {
      const result = await draftFrom(rowsOf(row({ country: 'NG', priceMin: 4000, priceMax: 5000 }), row({ country: 'NG', priceMin: 1, priceMax: 2 })))

      expect(result.availability).toEqual([{ country: 'NG', priceMin: 4000, priceMax: 5000, whereSold: 'Pharmacies and online', sourceUrl: BRAND_PAGE }])
    })

    it('accepts a lowest price of 1 and a single price, at the boundaries of the price rule', async () => {
      const result = await draftFrom(rowsOf(row({ country: 'NG', priceMin: 1, priceMax: 1 }), row({ country: 'GB', priceMin: 5000, priceMax: 5000 })))

      expect(result.availability.map((r) => [r.country, r.priceMin, r.priceMax])).toEqual([
        ['NG', 1, 1],
        ['GB', 5000, 5000],
      ])
    })

    it('keeps a row whose highest price is exactly 2.5 times the lowest, and drops one above it, since a wider spread is not one product\'s price', async () => {
      const result = await draftFrom(rowsOf(row({ country: 'NG', priceMin: 4000, priceMax: 10000 }), row({ country: 'GB', priceMin: 4000, priceMax: 10001 })))

      expect(result.availability.map((r) => [r.country, r.priceMin, r.priceMax])).toEqual([['NG', 4000, 10000]])
    })

    it('drops a range that runs across pack sizes, and keeps the other country', async () => {
      const result = await draftFrom(rowsOf(row({ country: 'NG', priceMin: 9000, priceMax: 31000 }), row({ country: 'GB', priceMin: 9, priceMax: 12 })))

      expect(result.availability.map((r) => r.country)).toEqual(['GB'])
    })

    it('keeps the row but leaves out where_sold when it holds a link or markup, since the workbook takes plain words only', async () => {
      const result = await draftFrom(rowsOf(row({ whereSold: 'Buy at https://shop.example/cerave' })))

      expect(result.availability).toHaveLength(1)
      expect(result.availability[0]!.whereSold ?? null).toBeNull()
    })

    it.each([['a newline', 'Pharmacies\nand online'], ['a tab', 'Pharmacies\tonline'], ['a NUL', 'Pharm\u0000acies']])('keeps the row but leaves out where_sold when it holds %s', async (_label, whereSold) => {
      const result = await draftFrom(rowsOf(row({ whereSold })))

      expect(result.availability).toHaveLength(1)
      expect(result.availability[0]!.whereSold ?? null).toBeNull()
    })

    it('keeps where_sold of exactly 200 characters, and leaves out one of 201 (keeping the row)', async () => {
      const result = await draftFrom(rowsOf(row({ country: 'NG', whereSold: 'a'.repeat(200) }), row({ country: 'GB', priceMin: 9, priceMax: 12, whereSold: 'a'.repeat(201) })))

      expect(result.availability.map((r) => r.whereSold ?? null)).toEqual(['a'.repeat(200), null])
    })
  })

  describe('price rows sourced from a page that is not one product\'s', () => {
    // The NG row cites `page`; the GB row is good. A refused page drops the NG row and only that row.
    const draftWithNgOn = (page: string) =>
      draftFrom(rowsOf(row({ country: 'NG', sourceUrl: page }), row({ country: 'GB', priceMin: 9, priceMax: 12, sourceUrl: RETAILER_PAGE })), REQUEST, [page, RETAILER_PAGE])

    it.each([
      'https://www.pricespy.co.uk/product/acme-gentle-wash/123',
      'https://pricespy.com/p/acme-gentle-wash-123.html',
      'https://www.pricerunner.com/pl/acme-gentle-wash',
      'https://uk.pricerunner.com/product/acme-gentle-wash/123',
      'https://www.idealo.de/preisvergleich/OffersOfProduct/123.html',
      'https://www.idealo.co.uk/compare/123/acme-gentle-wash.html',
      'https://www.kelkoo.co.uk/ctl/do/search/acme-gentle-wash',
      'https://www.kelkoo.com/products/acme-gentle-wash',
      'https://www.trolley.co.uk/product/acme-gentle-wash/ABC123',
      'https://TROLLEY.CO.UK/product/acme-gentle-wash/ABC123',
      'https://shopping.google.com/product/acme-gentle-wash',
      'https://shopping.google.co.uk/product/acme-gentle-wash',
      'https://www.google.com/shopping/product/123',
      'https://www.google.co.uk/shopping/product/123',
      'https://google.com.ng/shopping/product/123',
    ])('drops a price row sourced from the price-comparison site %s, even with a product-shaped path, and keeps the other country', async (page) => {
      const result = await draftWithNgOn(page)

      expect(result.availability.map((r) => r.country)).toEqual(['GB'])
    })

    it.each([
      'https://shop.example/search/acme-gentle-wash',
      'https://shop.example/Search/acme-gentle-wash',
      'https://shop.example/en/search/results/acme-gentle-wash',
      'https://shop.example/catalogsearch/result/',
      'https://shop.example/CatalogSearch/result/',
      'https://shop.example/slp/acme-gentle-wash',
      'https://beauty.example.ng/SLP/acme-gentle-wash/',
      'https://beauty.example.ng/search',
      'https://shop.example/p/acme-gentle-wash/123?q=acme',
      'https://shop.example/p/acme-gentle-wash/123?query=acme',
      'https://shop.example/p/acme-gentle-wash/123?search=acme',
      'https://shop.example/p/acme-gentle-wash/123?s=acme',
      'https://shop.example/p/acme-gentle-wash/123?k=acme',
      'https://shop.example/p/acme-gentle-wash/123?keyword=acme',
      'https://shop.example/p/acme-gentle-wash/123?searchterm=acme',
      'https://shop.example/p/acme-gentle-wash/123?Q=acme',
      'https://shop.example/p/acme-gentle-wash/123?SearchTerm=acme',
      'https://shop.example/p/acme-gentle-wash/123?affil=x&q=acme',
      'https://shop.example/?s=acme+gentle+wash',
    ])('drops a price row sourced from the search page %s, and keeps the other country', async (page) => {
      const result = await draftWithNgOn(page)

      expect(result.availability.map((r) => r.country)).toEqual(['GB'])
    })

    it.each([
      'https://shop.example/mlp-skincare',
      'https://shop.example/mlp-skincare/',
      'https://shop.example/en/MLP-face-washes/',
      'https://shop.example/brands/acme',
      'https://shop.example/brands/acme/',
      'https://shop.example/Brands/Acme',
      'https://shop.example/brand/acme',
      'https://shop.example/category/cleansers',
      'https://shop.example/categories/cleansers',
      'https://shop.example/collections/cleansers',
      'https://shop.example/COLLECTIONS/cleansers',
      'https://shop.example/brands',
      'https://shop.example/en/collections/',
      'https://shop.example/shop/category',
    ])('drops a price row sourced from the listing page %s, and keeps the other country', async (page) => {
      const result = await draftWithNgOn(page)

      expect(result.availability.map((r) => r.country)).toEqual(['GB'])
    })

    it.each([
      'https://shop.example/p/acme-gentle-wash/12345/',
      'https://shop.example/acme-gentle-wash-12345.html',
      'https://shop.example/products/acme-gentle-wash',
      'https://shop.example/shop/acme-gentle-wash/',
      'https://shop.example/product/acme-gentle-wash',
      'https://shop.example/collections/face/products/acme-gentle-wash',
      'https://shop.example/brands/acme/gentle-wash-200ml',
      'https://shop.example/category/cleansers/acme-gentle-wash-200ml',
      'https://shop.example/p/acme-gentle-wash/12345?variant=123',
      'https://shop.example/p/acme-gentle-wash/12345?affil=x',
      'https://shop.example/p/acme-gentle-wash/12345?sku=1&size=200ml',
    ])('keeps a price row sourced from the product page %s', async (page) => {
      const result = await draftWithNgOn(page)

      expect(result.availability.map((r) => [r.country, r.sourceUrl])).toEqual([
        ['NG', page],
        ['GB', RETAILER_PAGE],
      ])
    })

    it.each([
      // A word in the rules inside a longer segment, or in a place the rules do not look, is not a search or listing page.
      'https://shop.example/p/research-serum/123',
      'https://shop.example/products/search-and-rescue-balm',
      'https://shop.example/p/acme-mlp-wash/123',
      'https://shop.example/products/brands-acme-gentle-wash',
      'https://shop.example/p/acme-gentle-wash/123?squeeze=1&queries=2',
      // Host names that only contain a comparison site's name, or have it away from the registrable label.
      'https://pricespy.shop.example/p/acme-gentle-wash/123',
      'https://trolley.shop.example/p/acme-gentle-wash/123',
      'https://notidealo.example/p/acme-gentle-wash/123',
      'https://shop.example/idealo/acme-gentle-wash',
      'https://www.example.com/shopping/acme-gentle-wash',
    ])('keeps a price row sourced from %s, which only looks like a refused page', async (page) => {
      const result = await draftWithNgOn(page)

      expect(result.availability.map((r) => r.country)).toEqual(['NG', 'GB'])
    })

    it('falls back to the next row for a country when the first row\'s page is refused', async () => {
      const result = await draftFrom(
        rowsOf(
          row({ country: 'NG', sourceUrl: 'https://shop.example/search?q=acme' }),
          row({ country: 'NG', priceMin: 4100, priceMax: 5000, sourceUrl: 'https://shop.example/products/acme-gentle-wash' }),
        ),
        REQUEST,
        ['https://shop.example/search?q=acme', 'https://shop.example/products/acme-gentle-wash'],
      )

      expect(result.availability.map((r) => [r.country, r.priceMin])).toEqual([['NG', 4100]])
    })

    it.each([
      'https://shop.example/brands/acme',
      'https://shop.example/collections/cleansers',
      'https://shop.example/mlp-skincare',
      'https://shop.example/search?q=acme',
      'https://shop.example/catalogsearch/result/',
      'https://www.pricespy.co.uk/product/acme-gentle-wash/123',
      'https://shopping.google.com/product/acme-gentle-wash',
    ])('still keeps a cell whose source is %s, since only price rows need a single product\'s page', async (page) => {
      const result = await draftFrom(cellsOf({ frequency: { value: 'pm', sourceUrl: page } }), REQUEST, [page])

      expect(result.cells.frequency).toEqual({ value: 'pm', sourceUrl: page })
    })
  })

  describe('answers that cannot be used', () => {
    const EMPTY = { cells: {}, availability: [] }

    it.each([
      ['prose with no JSON', 'I could not find reliable information for this product.'],
      ['truncated JSON', '{"cells": {"frequency": {"value": "pm"'],
      ['cells that are not an object', JSON.stringify({ cells: 'none', availability: [] })],
      ['availability that is not a list', JSON.stringify({ cells: {}, availability: 'NG' })],
      ['JSON that is not an answer', JSON.stringify({ found: true })],
    ])('returns nothing, instead of throwing, for %s', async (_label, text) => {
      const result = await draft(searched(text))

      expect(result).toEqual(EMPTY)
    })

    it('returns a new object each time, so a caller that changes one result does not change the next', async () => {
      const { drafter } = drafterOver(respondWith(searched('No answer.')))

      const first = await drafter.draft(REQUEST)
      first.availability.push({ country: 'NG', priceMin: 1, priceMax: 2, sourceUrl: BRAND_PAGE })
      const second = await drafter.draft(REQUEST)

      expect(second).toEqual(EMPTY)
      expect(second).not.toBe(first)
    })

    it('returns nothing when the model says there is nothing', async () => {
      const result = await draftFrom({ cells: {}, availability: [] })

      expect(result).toEqual(EMPTY)
    })
  })
})

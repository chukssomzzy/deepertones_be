import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicClient } from '../anthropic/anthropic.client'
import { AnthropicRequestError, AnthropicUnavailableError } from '../anthropic/anthropic.provider'
import {
  API_KEY,
  type Block,
  caught,
  citation,
  errorResponse,
  MODEL,
  messageResponse,
  requestText,
  searchCall,
  searchResults,
  stubFetch,
  textBlock,
} from '../anthropic/messages-api.fake'
import { AnthropicProductResearcher } from './anthropic.product-researcher'
import type { ProductIdentity } from './product-researcher.provider'

const OFFICIAL = 'https://www.cerave.example/products/hydrating-cleanser'
const RETAILER = 'https://www.retailer.example/p/cerave-hydrating-cleanser'
const INVENTED = 'https://www.invented.example/made-up-page'
const IMAGE = 'https://www.cerave.example/images/hydrating-cleanser.png'

const PRODUCT: ProductIdentity = {
  brand: 'CeraVe',
  name: 'Hydrating Facial Cleanser',
  variant: 'Normal to Dry Skin',
  category: 'skin',
}

type Answer = { found: boolean; ingredients: unknown; sourceUrl: unknown; imageUrl: unknown }

const answer = (overrides: Partial<Answer> = {}): Answer => ({
  found: true,
  ingredients: ['Aqua', 'Glycerin', 'Niacinamide'],
  sourceUrl: OFFICIAL,
  imageUrl: IMAGE,
  ...overrides,
})

/** A completed web-search turn that ends with `finalText`; the search returned OFFICIAL and RETAILER. */
const searched = (finalText: string, urls = [OFFICIAL, RETAILER], citations?: Block[]): Block[] => [
  textBlock('Let me look that up.'),
  searchCall('srvtoolu_01', 'CeraVe Hydrating Facial Cleanser ingredients'),
  searchResults('srvtoolu_01', urls),
  textBlock(finalText, citations),
]

const respondWith = (content: Block[], stop_reason = 'end_turn') => () => messageResponse({ content, stop_reason })

const make = () => new AnthropicProductResearcher(new AnthropicClient({ apiKey: API_KEY, model: MODEL, apiUrl: 'https://anthropic.example/v1/messages' }))

const research = async (content: Block[]) => {
  stubFetch(respondWith(content))
  return make().research(PRODUCT)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AnthropicProductResearcher.research', () => {
  it('returns the ingredients, cited source and image when the model found them on a page the search returned', async () => {
    const result = await research(searched(JSON.stringify(answer()), [OFFICIAL, RETAILER], [citation(OFFICIAL)]))

    expect(result).toStrictEqual({
      found: true,
      ingredients: ['Aqua', 'Glycerin', 'Niacinamide'],
      sourceUrl: OFFICIAL,
      imageUrl: IMAGE,
    })
  })

  it('accepts a source that the search returned even when the answer text carries no citation', async () => {
    const result = await research(searched(JSON.stringify(answer({ sourceUrl: RETAILER }))))

    expect(result).toMatchObject({ found: true, sourceUrl: RETAILER })
  })

  it('finds the JSON inside a json code fence with prose around it', async () => {
    const text = `Here is what I found:\n\`\`\`json\n${JSON.stringify(answer())}\n\`\`\`\nHope that helps.`

    const result = await research(searched(text))

    expect(result).toMatchObject({ found: true, ingredients: ['Aqua', 'Glycerin', 'Niacinamide'], sourceUrl: OFFICIAL })
  })

  it('finds a bare JSON object after prose', async () => {
    const result = await research(searched(`I found the official page. ${JSON.stringify(answer())}`))

    expect(result).toMatchObject({ found: true, sourceUrl: OFFICIAL })
  })

  it('trims ingredient names, drops empty ones and keeps the order', async () => {
    const ingredients = ['  Aqua ', '', 'Glycerin', '   ', '\tNiacinamide\n']

    const result = await research(searched(JSON.stringify(answer({ ingredients }))))

    expect(result).toMatchObject({ found: true, ingredients: ['Aqua', 'Glycerin', 'Niacinamide'] })
  })

  it.each([
    ['null', null],
    ['an http url', 'http://www.cerave.example/images/x.png'],
    ['a relative url', '/images/x.png'],
    ['a javascript url', 'javascript:alert(1)'],
    ['not a url', 'a picture of the bottle'],
    ['an empty string', ''],
    ['a url with credentials', 'https://user:secret@www.cerave.example/x.png'],
    ['a url with a username only', 'https://user@www.cerave.example/x.png'],
    ['a url with a port', 'https://www.cerave.example:8443/x.png'],
    ['localhost', 'https://localhost/x.png'],
    ['localhost with a trailing dot', 'https://localhost./x.png'],
    ['a localhost subdomain', 'https://admin.localhost/x.png'],
    ['an IPv4 literal', 'https://203.0.113.7/x.png'],
    ['a loopback IPv4 literal', 'https://127.0.0.1/x.png'],
    ['a decimal IPv4 literal', 'https://2130706433/x.png'],
    ['an IPv6 literal', 'https://[2001:db8::1]/x.png'],
    ['a loopback IPv6 literal', 'https://[::1]/x.png'],
    ['a single-label host', 'https://intranet/x.png'],
  ])('omits imageUrl when it is %s', async (_label, imageUrl) => {
    const result = await research(searched(JSON.stringify(answer({ imageUrl }))))

    expect(result).toStrictEqual({ found: true, ingredients: ['Aqua', 'Glycerin', 'Niacinamide'], sourceUrl: OFFICIAL })
  })

  it('omits imageUrl for a host the shared URL-safety check rejects', async () => {
    const result = await research(searched(JSON.stringify(answer({ imageUrl: 'https://0x7f.1/x.png' }))))

    expect(result).toStrictEqual({ found: true, ingredients: ['Aqua', 'Glycerin', 'Niacinamide'], sourceUrl: OFFICIAL })
  })

  it('omits imageUrl when the answer has none', async () => {
    const { imageUrl: _omitted, ...withoutImage } = answer()

    const result = await research(searched(JSON.stringify(withoutImage)))

    expect(result).toStrictEqual({ found: true, ingredients: ['Aqua', 'Glycerin', 'Niacinamide'], sourceUrl: OFFICIAL })
  })

  it('uses the last object that fits the answer shape, not an earlier one', async () => {
    const draft = JSON.stringify(answer({ ingredients: ['Draft only'], sourceUrl: RETAILER }))
    const text = `First attempt: ${draft}\nOn reflection, the official page is better: ${JSON.stringify(answer())}`

    const result = await research(searched(text))

    expect(result).toStrictEqual({ found: true, ingredients: ['Aqua', 'Glycerin', 'Niacinamide'], sourceUrl: OFFICIAL, imageUrl: IMAGE })
  })

  it('skips a trailing object that is not an answer and uses the one before it', async () => {
    const result = await research(searched(`${JSON.stringify(answer())}\nNote: {"unrelated": true}`))

    expect(result).toMatchObject({ found: true, sourceUrl: OFFICIAL })
  })

  it('reads an answer whose strings contain braces and escaped quotes', async () => {
    const ingredients = ['Aqua', 'Fragrance {Parfum}', 'Say "hi" \\ }']

    const result = await research(searched(JSON.stringify(answer({ ingredients }))))

    expect(result).toMatchObject({ found: true, ingredients })
  })

  it.each([
    ['opening braces before the answer', (a: string) => `${'{'.repeat(50_000)} ${a}`, true],
    ['opening braces after the answer', (a: string) => `${a} ${'{'.repeat(50_000)}`, true],
    ['closing braces after the answer', (a: string) => `${a} ${'}'.repeat(50_000)}`, false],
    ['nothing but closing braces', () => '}'.repeat(50_000), false],
    ['nothing but opening braces', () => '{'.repeat(50_000), false],
  ])('stays fast on text with 50k unbalanced braces: %s', async (_label, build, found) => {
    stubFetch(respondWith(searched(build(JSON.stringify(answer())))))
    const researcher = make()

    const started = performance.now()
    const result = await researcher.research(PRODUCT)
    const elapsed = performance.now() - started

    expect(result.found).toBe(found)
    expect(elapsed).toBeLessThan(50)
  })

  it.each([
    ['more than 150 ingredients', Array.from({ length: 151 }, (_, i) => `Ingredient ${i}`)],
    ['an ingredient longer than 120 characters', ['Aqua', 'A'.repeat(121)]],
    ['an ingredient with a control character', ['Aqua', 'Glyc\u0007erin']],
    ['an ingredient with a tab inside', ['Aqua', 'Glyc\terin']],
    ['an ingredient with a newline inside', ['Aqua', 'Glyc\nerin']],
  ])('reports not found for %s', async (_label, ingredients) => {
    const result = await research(searched(JSON.stringify(answer({ ingredients }))))

    expect(result).toStrictEqual({ found: false })
  })

  it('accepts exactly 150 ingredients of exactly 120 characters', async () => {
    const ingredients = Array.from({ length: 150 }, (_, i) => `${i}`.padEnd(120, 'x'))

    const result = await research(searched(JSON.stringify(answer({ ingredients }))))

    expect(result).toMatchObject({ found: true, ingredients })
  })

  it('reports not found when the model says it found nothing', async () => {
    const result = await research(searched(JSON.stringify({ found: false, ingredients: [], sourceUrl: null, imageUrl: null })))

    expect(result).toStrictEqual({ found: false })
  })

  it('reports not found when the model says found but the source is not a page the search returned', async () => {
    const result = await research(searched(JSON.stringify(answer({ sourceUrl: INVENTED }))))

    expect(result).toStrictEqual({ found: false })
  })

  it('reports not found when the search itself returned nothing usable, whatever source the model names', async () => {
    const content = [
      searchCall('srvtoolu_01', 'q'),
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_01', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } },
      textBlock(JSON.stringify(answer())),
    ]

    const result = await research(content)

    expect(result).toStrictEqual({ found: false })
  })

  it('reports not found when the ingredient list is empty', async () => {
    const result = await research(searched(JSON.stringify(answer({ ingredients: [] }))))

    expect(result).toStrictEqual({ found: false })
  })

  it('reports not found when every ingredient name is blank', async () => {
    const result = await research(searched(JSON.stringify(answer({ ingredients: ['', '  '] }))))

    expect(result).toStrictEqual({ found: false })
  })

  it.each([
    ['prose with no JSON', 'I could not find a reliable ingredient list for this product.'],
    ['truncated JSON', '{"found": true, "ingredients": ["Aqua"'],
    ['ingredients that are not a list', JSON.stringify(answer({ ingredients: 'Aqua, Glycerin' }))],
    ['ingredients that are not strings', JSON.stringify(answer({ ingredients: [1, 2] }))],
    ['a source that is not a string', JSON.stringify(answer({ sourceUrl: 42 }))],
    ['a missing found flag', JSON.stringify({ ingredients: ['Aqua'], sourceUrl: OFFICIAL, imageUrl: null })],
  ])('reports not found instead of throwing for %s', async (_label, text) => {
    const result = await research(searched(text))

    expect(result).toStrictEqual({ found: false })
  })

  it('asks Claude with the web search tool and no forced tool choice, using the configured model', async () => {
    const calls = stubFetch(respondWith(searched(JSON.stringify(answer()))))

    await make().research(PRODUCT)

    expect(calls).toHaveLength(1)
    const body = calls[0]!.body
    expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
    expect('tool_choice' in body).toBe(false)
    expect(body.model).toBe(MODEL)
    expect(body.max_tokens).toBeGreaterThan(0)
    expect(body.messages[0].role).toBe('user')
  })

  it('puts every part of the product identity in the prompt', async () => {
    const calls = stubFetch(respondWith(searched(JSON.stringify(answer()))))

    await make().research(PRODUCT)

    const prompt = requestText(calls[0]!.body)
    expect(prompt).toContain('CeraVe')
    expect(prompt).toContain('Hydrating Facial Cleanser')
    expect(prompt).toContain('Normal to Dry Skin')
    expect(prompt).toContain('skin')
  })

  it('researches a product that has no variant', async () => {
    const calls = stubFetch(respondWith(searched(JSON.stringify(answer()))))
    const { variant: _variant, ...withoutVariant } = PRODUCT

    const result = await make().research(withoutVariant)

    expect(result).toMatchObject({ found: true })
    expect(requestText(calls[0]!.body)).not.toContain('undefined')
  })

  it('completes a search that pauses, using the results from the earlier turn to check the source', async () => {
    const paused: Block[] = [
      textBlock('Let me look that up.'),
      searchCall('srvtoolu_01', 'CeraVe Hydrating Facial Cleanser ingredients'),
      searchResults('srvtoolu_01', [OFFICIAL, RETAILER]),
    ]
    const calls = stubFetch(respondWith(paused, 'pause_turn'), respondWith([textBlock(JSON.stringify(answer()))]))

    const result = await make().research(PRODUCT)

    expect(calls).toHaveLength(2)
    expect(calls[1]!.body.messages.at(-1)).toEqual({ role: 'assistant', content: paused })
    expect(result).toMatchObject({ found: true, sourceUrl: OFFICIAL })
  })

  it('lets AnthropicUnavailableError through when Claude is overloaded', async () => {
    stubFetch(() => errorResponse(529, 'overloaded_error'))

    expect(await caught(make().research(PRODUCT))).toBeInstanceOf(AnthropicUnavailableError)
  })

  it('lets AnthropicRequestError through when the request is rejected', async () => {
    stubFetch(() => errorResponse(400, 'invalid_request_error'))

    expect(await caught(make().research(PRODUCT))).toBeInstanceOf(AnthropicRequestError)
  })
})

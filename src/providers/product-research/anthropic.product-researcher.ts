import { z } from 'zod'
import { isSafePublicHttpsUrl } from '../../lib/url-safety'
import { productResearcherResearchPrompt } from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import { sourceUrlsOf, textOf } from '../anthropic/anthropic.provider'
import type { ProductIdentity, ProductResearcher, ResearchResult } from './product-researcher.provider'

// A type outside the class cannot read its private members (TS2341), so the answer shape is spelled out beside the schema it mirrors.
type Answer = { found: boolean; ingredients: string[]; sourceUrl?: string | null; imageUrl?: unknown }

/** Researches a product's ingredients with Claude and its web search tool. */
export class AnthropicProductResearcher implements ProductResearcher {
  private static readonly MAX_TOKENS = 4096
  private static readonly MAX_SEARCHES = 5

  private static readonly ANSWER_SCHEMA = z.object({
    found: z.boolean(),
    ingredients: z.array(z.string()),
    sourceUrl: z.string().nullish(),
    imageUrl: z.unknown().optional(),
  })

  private static readonly NOT_FOUND: ResearchResult = { found: false }

  // An INCI list is a few dozen entries; anything far outside this is a mangled page or an injection.
  private static readonly MAX_INGREDIENTS = 150
  private static readonly MAX_INGREDIENT_LENGTH = 120
  private static readonly CONTROL_CHARACTER = /\p{Cc}/u

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async research(product: ProductIdentity): Promise<ResearchResult> {
    const message = await this.client.createMessage(
      {
        max_tokens: AnthropicProductResearcher.MAX_TOKENS,
        system: productResearcherResearchPrompt.text,
        messages: [{ role: 'user', content: `Find the ingredient list for this product:\n${JSON.stringify(product)}` }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: AnthropicProductResearcher.MAX_SEARCHES }],
      },
      { job: productResearcherResearchPrompt.job },
    )

    // The model can name a page it never saw, so the source must be one the search returned.
    // Any answer that cannot be read or checked is "not found": the caller has a fallback for that.
    const notFound = AnthropicProductResearcher.NOT_FOUND
    const answer = AnthropicProductResearcher.lastAnswerIn(textOf(message))
    if (!answer?.found) return notFound
    const ingredients = answer.ingredients.map((name) => name.trim()).filter((name) => name !== '')
    const { sourceUrl } = answer
    if (!AnthropicProductResearcher.withinBounds(ingredients) || !sourceUrl || !sourceUrlsOf(message).has(sourceUrl)) return notFound

    // A first filter only: the image store checks again when it downloads.
    const imageUrl = isSafePublicHttpsUrl(answer.imageUrl) ? answer.imageUrl : undefined
    return { found: true, ingredients, sourceUrl, ...(imageUrl !== undefined && { imageUrl }) }
  }

  private static withinBounds(ingredients: string[]): boolean {
    return (
      ingredients.length > 0 &&
      ingredients.length <= AnthropicProductResearcher.MAX_INGREDIENTS &&
      ingredients.every(
        (name) => name.length <= AnthropicProductResearcher.MAX_INGREDIENT_LENGTH && !AnthropicProductResearcher.CONTROL_CHARACTER.test(name),
      )
    )
  }

  /**
   * The last JSON object in the text that fits the answer shape: the final answer comes after any
   * chatter. Walks back from the last "}" to its matching "{", so the work is linear in the text.
   * Stray braces after the answer end the search with nothing found rather than risk a quadratic scan.
   */
  private static lastAnswerIn(text: string): Answer | undefined {
    for (let end = text.lastIndexOf('}'); end !== -1; ) {
      const start = AnthropicProductResearcher.balancedStart(text, end)
      if (start === -1) return undefined
      try {
        const parsed = AnthropicProductResearcher.ANSWER_SCHEMA.safeParse(JSON.parse(text.slice(start, end + 1)))
        if (parsed.success) return parsed.data
      } catch {
        // not JSON; try the object before it
      }
      end = text.lastIndexOf('}', start - 1)
    }
    return undefined
  }

  /** Index of the brace opening the object that closes at `end`, or -1. Braces inside strings do not count. */
  private static balancedStart(text: string, end: number): number {
    let depth = 0
    let inString = false
    for (let i = end; i >= 0; i--) {
      const char = text[i]
      if (char === '"' && !AnthropicProductResearcher.isEscaped(text, i)) inString = !inString
      else if (inString) continue
      else if (char === '}') depth++
      else if (char === '{' && --depth === 0) return i
    }
    return -1
  }

  private static isEscaped(text: string, quote: number): boolean {
    let backslashes = 0
    while (text[quote - 1 - backslashes] === '\\') backslashes++
    return backslashes % 2 === 1
  }
}

import { z } from 'zod'
import { catalogDrafterDraftCatalogRowPrompt } from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import { AnthropicRefusalError, AnthropicRequestError, lastJsonObjectIn, sourceUrlsOf, textOf } from '../anthropic/anthropic.provider'
import { type CatalogDrafter, checkedDraft, DRAFT_VOCABULARY, type DraftRequest, type DraftResult } from './catalog-drafter.provider'

/** Drafts a product's empty catalog cells with Claude and its web search tool. */
export class AnthropicCatalogDrafter implements CatalogDrafter {
  // Several countries' prices, each with a shop and a page, come to a long answer; one cut off at the limit is refused, not read.
  private static readonly MAX_TOKENS = 8192
  // Two searches for the product's pages, then one for its price in each country, to a most of 6.
  private static readonly BASE_SEARCHES = 2
  private static readonly MAX_SEARCHES = 6

  // What of the shape matters here: whether it is an answer at all. Every value in it is checked by checkedDraft.
  private static readonly ANSWER_SCHEMA = z.object({
    cells: z.record(z.string(), z.unknown()),
    availability: z.array(z.unknown()),
  })

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async draft(request: DraftRequest): Promise<DraftResult> {
    const message = await this.client.createMessage(
      {
        max_tokens: AnthropicCatalogDrafter.MAX_TOKENS,
        system: catalogDrafterDraftCatalogRowPrompt.text,
        messages: [
          {
            role: 'user',
            content:
              'Draft these cells for this product:\n' +
              JSON.stringify({ product: request.product, columns: request.columns, countries: request.countries, allowedValues: DRAFT_VOCABULARY }),
          },
        ],
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: Math.min(AnthropicCatalogDrafter.MAX_SEARCHES, AnthropicCatalogDrafter.BASE_SEARCHES + request.countries.length),
          },
        ],
      },
      { job: catalogDrafterDraftCatalogRowPrompt.job },
    )

    // As the client's structured() does: an answer cut off or refused is not an answer, and the caller records the product as failed.
    if (message.stop_reason === 'refusal') throw new AnthropicRefusalError('Claude refused to answer')
    if (message.stop_reason === 'max_tokens') throw new AnthropicRequestError('Claude ran out of max_tokens before finishing the answer')

    // The model can name a page it never saw, so a source must be one the search returned. A model that did not search has no source to give.
    // An answer that cannot be read is nothing: the caller leaves the cells for a person.
    const answer = lastJsonObjectIn(textOf(message), AnthropicCatalogDrafter.ANSWER_SCHEMA)
    if (!answer) return { cells: {}, availability: [] }
    return checkedDraft(answer, request, sourceUrlsOf(message))
  }
}

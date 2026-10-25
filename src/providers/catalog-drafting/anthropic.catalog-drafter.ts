import { z } from 'zod'
import { catalogDrafterDraftCatalogRowPrompt } from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import { AnthropicRefusalError, AnthropicRequestError, fetchedUrlsOf, lastJsonObjectIn, sourceUrlsOf, textOf } from '../anthropic/anthropic.provider'
import { type CatalogDrafter, checkedDraft, DRAFT_VOCABULARY, type DraftRequest, type DraftResult } from './catalog-drafter.provider'

/** Drafts a product's empty catalog cells with Claude and its web search tool. */
export class AnthropicCatalogDrafter implements CatalogDrafter {
  // Haiku's adaptive thinking and up to 6 search rounds count against max_tokens along with the answer; a smaller limit cut
  // answers off, and one cut off is refused, not read, after a paid call. Only the tokens used are billed.
  private static readonly MAX_TOKENS = 16000
  // Two searches for the product's pages, then one for its price in each country, to a most of 6.
  private static readonly BASE_SEARCHES = 2
  private static readonly MAX_SEARCHES = 6
  // One fetch of a price page for each country, to a most of 4. A fetched page is billed as input tokens, so what one fetch may bring in is bounded too.
  private static readonly MAX_FETCHES = 4
  private static readonly MAX_PAGE_TOKENS = 12_000

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
              (request.attempt !== undefined && request.attempt > 1
                ? 'An earlier attempt found no usable price for these countries, so look more widely: other retailers and pharmacies, marketplace product pages, and price-comparison pages for this exact product.\n'
                : '') +
              JSON.stringify({ product: request.product, columns: request.columns, countries: request.countries, allowedValues: DRAFT_VOCABULARY }),
          },
        ],
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: Math.min(AnthropicCatalogDrafter.MAX_SEARCHES, AnthropicCatalogDrafter.BASE_SEARCHES + request.countries.length),
          },
          // Only a price is read from a page, so with no country to price there is nothing to fetch.
          ...(request.countries.length > 0
            ? [
                {
                  type: 'web_fetch_20260318',
                  name: 'web_fetch',
                  max_uses: Math.min(AnthropicCatalogDrafter.MAX_FETCHES, request.countries.length),
                  max_content_tokens: AnthropicCatalogDrafter.MAX_PAGE_TOKENS,
                  // By default this tool version runs through code execution (dynamic filtering), whose fetch results may not come back as top-level blocks for fetchedUrlsOf.
                  allowed_callers: ['direct'],
                },
              ]
            : []),
        ],
      },
      { job: catalogDrafterDraftCatalogRowPrompt.job },
    )

    // As the client's structured() does: an answer cut off or refused is not an answer, and the caller records the product as failed.
    if (message.stop_reason === 'refusal') throw new AnthropicRefusalError('Claude refused to answer')
    if (message.stop_reason === 'max_tokens') throw new AnthropicRequestError('Claude ran out of max_tokens before finishing the answer')

    // The model can name a page it never saw, so a source must be one the search returned or it fetched. A model that did neither has no source to give.
    // An answer that cannot be read is nothing: the caller leaves the cells for a person.
    const answer = lastJsonObjectIn(textOf(message), AnthropicCatalogDrafter.ANSWER_SCHEMA)
    if (!answer) return { cells: {}, availability: [] }
    return checkedDraft(answer, request, { searched: sourceUrlsOf(message), fetched: fetchedUrlsOf(message) })
  }
}

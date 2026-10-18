import { z } from 'zod'
import { base64Of } from '../../lib/base64'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { labelReaderReadLabelPrompt } from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { ProductCategory } from '../product-research/product-researcher.provider'
import type { LabelReader, LabelReading } from './label-reader.provider'

/**
 * Reads a label's ingredient list, and the brand, name, variant and category it prints, with Claude. The model is not trusted:
 * any ingredient out of bounds makes the whole list unreadable, while a name field out of bounds is dropped on its own.
 */
export class AnthropicLabelReader implements LabelReader {
  // Haiku 5.5's adaptive thinking counts against max_tokens: a small budget can be spent thinking and cut the answer off.
  private static readonly MAX_TOKENS = 4096
  private static readonly MAX_INGREDIENTS = 150
  private static readonly MAX_INGREDIENT_LENGTH = 120
  // Control characters and invisible format characters (a right-to-left override, a zero-width space) can disguise an ingredient.
  private static readonly HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u
  private static readonly NAME_FIELDS = ['brand', 'name', 'variant'] as const
  private static readonly CATEGORIES = ['skin', 'hair', 'body', 'makeup', 'other'] as const satisfies readonly ProductCategory[]
  private static readonly NOT_READABLE: LabelReading = { readable: false }

  // The request advertises the five categories, but a category outside them must not fail the whole parse and lose the list:
  // it parses as absent, and so does a name field of the wrong type.
  private static readonly SCHEMA = z.object({
    readable: z.boolean(),
    ingredients: z.array(z.string()),
    brand: z.string().optional().catch(undefined),
    name: z.string().optional().catch(undefined),
    variant: z.string().optional().catch(undefined),
    category: z.enum(AnthropicLabelReader.CATEGORIES).optional().catch(undefined),
  })

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async read(image: ProductImage): Promise<LabelReading> {
    const answer = await this.client.structured(
      {
        max_tokens: AnthropicLabelReader.MAX_TOKENS,
        system: labelReaderReadLabelPrompt.text,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: base64Of(image.bytes) } },
              { type: 'text', text: 'Read the ingredient list on this label, and the brand, name and variant it prints.' },
            ],
          },
        ],
      },
      AnthropicLabelReader.SCHEMA,
      { job: labelReaderReadLabelPrompt.job },
    )
    return AnthropicLabelReader.accept(answer)
  }

  private static accept({ readable, ingredients, category, ...printed }: z.infer<typeof AnthropicLabelReader.SCHEMA>): LabelReading {
    const notReadable = AnthropicLabelReader.NOT_READABLE
    if (!readable) return notReadable
    const entries = ingredients.map((entry) => entry.trim()).filter((entry) => entry !== '')
    if (entries.length === 0 || entries.length > AnthropicLabelReader.MAX_INGREDIENTS) return notReadable
    if (entries.some((entry) => !AnthropicLabelReader.isSafe(entry))) return notReadable

    const names: Partial<Record<(typeof AnthropicLabelReader.NAME_FIELDS)[number], string>> = {}
    for (const field of AnthropicLabelReader.NAME_FIELDS) {
      const text = printed[field]?.trim()
      if (text && AnthropicLabelReader.isSafe(text)) names[field] = text
    }
    return { readable: true, ingredients: entries, ...names, ...(category === undefined ? {} : { category }) }
  }

  private static isSafe(text: string): boolean {
    return text.length <= AnthropicLabelReader.MAX_INGREDIENT_LENGTH && !AnthropicLabelReader.HIDDEN_CHARACTER.test(text) && !hasLinkOrMarkup(text)
  }
}

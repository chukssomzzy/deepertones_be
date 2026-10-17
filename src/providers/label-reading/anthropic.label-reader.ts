import { z } from 'zod'
import { base64Of } from '../../lib/base64'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { labelReaderReadLabelPrompt } from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { LabelReader, LabelReading } from './label-reader.provider'

/** Reads a label's ingredient list with Claude. The model is not trusted: any entry out of bounds makes the whole list unreadable. */
export class AnthropicLabelReader implements LabelReader {
  // Haiku 5.5's adaptive thinking counts against max_tokens: a small budget can be spent thinking and cut the answer off.
  private static readonly MAX_TOKENS = 4096
  private static readonly MAX_INGREDIENTS = 150
  private static readonly MAX_INGREDIENT_LENGTH = 120
  // Control characters and invisible format characters (a right-to-left override, a zero-width space) can disguise an ingredient.
  private static readonly HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u
  private static readonly NOT_READABLE: LabelReading = { readable: false }

  private static readonly SCHEMA = z.object({
    readable: z.boolean(),
    ingredients: z.array(z.string()),
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
              { type: 'text', text: 'Read the ingredient list on this label.' },
            ],
          },
        ],
      },
      AnthropicLabelReader.SCHEMA,
      { job: labelReaderReadLabelPrompt.job },
    )
    return AnthropicLabelReader.accept(answer)
  }

  private static accept({ readable, ingredients }: { readable: boolean; ingredients: string[] }): LabelReading {
    const notReadable = AnthropicLabelReader.NOT_READABLE
    if (!readable) return notReadable
    const entries = ingredients.map((entry) => entry.trim()).filter((entry) => entry !== '')
    if (entries.length === 0 || entries.length > AnthropicLabelReader.MAX_INGREDIENTS) return notReadable
    if (
      entries.some(
        (entry) =>
          entry.length > AnthropicLabelReader.MAX_INGREDIENT_LENGTH || AnthropicLabelReader.HIDDEN_CHARACTER.test(entry) || hasLinkOrMarkup(entry),
      )
    ) {
      return notReadable
    }
    return { readable: true, ingredients: entries }
  }
}

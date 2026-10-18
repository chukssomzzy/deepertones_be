import { z } from 'zod'
import { normaliseText } from '../../lib/normalise-text'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { nameSplitterSplitNamePrompt } from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import type { ProductCategory } from '../product-research/product-researcher.provider'
import type { NameSplit, NameSplitter } from './name-splitter.provider'

/** Splits a typed product name into brand, name, variant and category with Claude. The model is not trusted: anything out of bounds is `not-a-product`. */
export class AnthropicNameSplitter implements NameSplitter {
  // Haiku 5.5's adaptive thinking counts against max_tokens: a small budget can be spent thinking and cut the answer off.
  private static readonly MAX_TOKENS = 4096
  private static readonly MAX_FIELD_LENGTH = 120
  // Control characters and invisible format characters (a right-to-left override, a zero-width space) can disguise a name.
  private static readonly HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u
  private static readonly NOT_A_PRODUCT: NameSplit = { kind: 'not-a-product' }

  private static readonly KINDS = ['product', 'not-a-product'] as const
  private static readonly CATEGORIES = ['skin', 'hair', 'body', 'makeup', 'other'] as const satisfies readonly ProductCategory[]

  // Every field is required and the object is closed, as structured outputs need. The three text fields accept a missing value, read as
  // empty, and a category outside the five parses as absent (which is why `catch` is given undefined, though the type says otherwise;
  // accept checks it), so a model that slips gets `not-a-product` rather than a failed call.
  private static readonly SCHEMA = z.object({
    kind: z.enum(AnthropicNameSplitter.KINDS),
    brand: AnthropicNameSplitter.orEmpty(z.string()),
    name: AnthropicNameSplitter.orEmpty(z.string()),
    variant: AnthropicNameSplitter.orEmpty(z.string().describe('Empty when the text gives no variant')),
    category: z.enum(AnthropicNameSplitter.CATEGORIES).catch(undefined as never),
  })

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async split(text: string): Promise<NameSplit> {
    const answer = await this.client.structured(
      {
        max_tokens: AnthropicNameSplitter.MAX_TOKENS,
        system: nameSplitterSplitNamePrompt.text,
        messages: [{ role: 'user', content: [{ type: 'text', text: `Split this product name:\n\n${text}` }] }],
      },
      AnthropicNameSplitter.SCHEMA,
      { job: nameSplitterSplitNamePrompt.job },
    )
    return AnthropicNameSplitter.accept(answer, text)
  }

  private static orEmpty<T extends z.ZodType<string>>(schema: T) {
    return z.preprocess((value) => value ?? '', schema)
  }

  /** A trimmed string no longer than the bound and free of hidden characters, links and markup, or undefined. An empty string stays empty. */
  private static cleanText(value: string): string | undefined {
    const text = value.trim()
    return text.length <= AnthropicNameSplitter.MAX_FIELD_LENGTH && !AnthropicNameSplitter.HIDDEN_CHARACTER.test(text) && !hasLinkOrMarkup(text)
      ? text
      : undefined
  }

  /** The text as the catalog keys it, with the spaces taken out, so "shea moisture" and "SheaMoisture", "50ml" and "50 ml" are the same. */
  private static squashed(text: string): string {
    return normaliseText(text).replaceAll(' ', '')
  }

  private static accept(answer: z.infer<typeof AnthropicNameSplitter.SCHEMA>, typed: string): NameSplit {
    if (answer.kind !== 'product') return AnthropicNameSplitter.NOT_A_PRODUCT

    const brand = AnthropicNameSplitter.cleanText(answer.brand)
    const name = AnthropicNameSplitter.cleanText(answer.name)
    const variant = AnthropicNameSplitter.cleanText(answer.variant)
    if (!brand || !name || variant === undefined || !AnthropicNameSplitter.CATEGORIES.includes(answer.category)) return AnthropicNameSplitter.NOT_A_PRODUCT
    // The model may only cut up the user's words: a brand or name it supplied from what it knows would reach the shared catalog as fact.
    // Each part must be (spacing, case, accents and punctuation aside) a stretch of what was typed; a part left empty is a variant not given.
    // The category is the model's call, not a typed word, so it is exempt.
    const typedText = AnthropicNameSplitter.squashed(typed)
    const fromTyped = (part: string) => {
      const squashed = AnthropicNameSplitter.squashed(part)
      return squashed !== '' && typedText.includes(squashed)
    }
    if (!fromTyped(brand) || !fromTyped(name) || (variant !== '' && !fromTyped(variant))) return AnthropicNameSplitter.NOT_A_PRODUCT
    return { kind: 'product', brand, name, ...(variant === '' ? {} : { variant }), category: answer.category }
  }
}

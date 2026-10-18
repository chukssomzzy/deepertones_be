import { z } from 'zod'
import { normaliseText } from '../../lib/normalise-text'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { mentionReaderReadMentionsPrompt } from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import type { ProductCategory } from '../product-research/product-researcher.provider'
import type { Mention, MentionReader } from './mention-reader.provider'

/**
 * Lists the products and ingredients a person named in typed words with Claude. The model is not trusted: a reply off the schema is "nothing named", a
 * mention that is not made of the person's own words is dropped, and the list is capped. None of it is a failed call.
 */
export class AnthropicMentionReader implements MentionReader {
  // Haiku 5.5's adaptive thinking counts against max_tokens: a small budget can be spent thinking and cut the answer off.
  private static readonly MAX_TOKENS = 4096
  private static readonly MAX_MENTIONS = 10
  private static readonly MAX_FIELD_LENGTH = 120
  // Control characters and invisible format characters (a right-to-left override, a zero-width space) can disguise a name.
  private static readonly HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u

  private static readonly KINDS = ['product', 'ingredient'] as const
  private static readonly CATEGORIES = ['skin', 'hair', 'body', 'makeup', 'other'] as const satisfies readonly ProductCategory[]

  // Every field is required and the object is closed, as structured outputs need. The schema has no null, so the model says "none" for a category
  // and leaves a brand or variant empty. The leniency is in the parse and none of it reaches the schema sent (a `default` would not be taken): a reply
  // that is not an object, or whose `mentions` is not a list, is read as no mentions; an item that does not fit parses as absent (which is why `catch`
  // is given undefined, though the type says otherwise; read filters it out), so one bad item costs only itself; a category outside the five parses
  // as absent and the mention is kept without one.
  private static readonly ITEM = z.object({
    kind: z.enum(AnthropicMentionReader.KINDS),
    brand: AnthropicMentionReader.orEmpty(z.string().describe('Empty when the person wrote no brand')),
    name: z.string(),
    variant: AnthropicMentionReader.orEmpty(z.string().describe('Empty when the person wrote no variant')),
    category: z.enum([...AnthropicMentionReader.CATEGORIES, 'none']).catch(undefined as never),
  })
  private static readonly SCHEMA = z.preprocess(
    (reply) => (reply !== null && typeof reply === 'object' && !Array.isArray(reply) ? reply : {}),
    z.object({
      mentions: z.preprocess((mentions) => (Array.isArray(mentions) ? mentions : []), z.array(AnthropicMentionReader.ITEM.catch(undefined as never))),
    }),
  )

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async read(text: string): Promise<Mention[]> {
    const answer = await this.client.structured(
      {
        max_tokens: AnthropicMentionReader.MAX_TOKENS,
        system: mentionReaderReadMentionsPrompt.text,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      },
      AnthropicMentionReader.SCHEMA,
      { job: mentionReaderReadMentionsPrompt.job },
    )
    const typed = { squashed: AnthropicMentionReader.squashed(text), words: normaliseText(text).split(' ') }
    const mentions: Mention[] = []
    // The cap counts the mentions kept, so one the checks dropped does not use up a place.
    for (const item of answer.mentions) {
      const mention = item && AnthropicMentionReader.accept(item, typed)
      if (mention) mentions.push(mention)
      if (mentions.length === AnthropicMentionReader.MAX_MENTIONS) break
    }
    return mentions
  }

  private static orEmpty<T extends z.ZodType<string>>(schema: T) {
    return z.preprocess((value) => value ?? '', schema)
  }

  /** A trimmed string no longer than the bound and free of hidden characters, links and markup, or undefined. An empty string stays empty. */
  private static cleanText(value: string): string | undefined {
    const text = value.trim()
    return text.length <= AnthropicMentionReader.MAX_FIELD_LENGTH && !AnthropicMentionReader.HIDDEN_CHARACTER.test(text) && !hasLinkOrMarkup(text)
      ? text
      : undefined
  }

  /** The text as the catalog keys it, with the spaces taken out, so "shea moisture" and "SheaMoisture", "50ml" and "50 ml" are the same. */
  private static squashed(text: string): string {
    return normaliseText(text).replaceAll(' ', '')
  }

  /**
   * The model may only cut up the person's words: a brand, name, variant or ingredient it supplied from what it knows would reach the shared catalog,
   * or stand as a fact about the person's skin, though they never wrote it. Each part must be (spacing, case, accents and punctuation aside) a stretch
   * of what was typed, or the same words in another order ("White Caro" typed, "Caro White" read), but only a run of words that sit together: words picked from
   * here and there would make a name nobody typed. A part left empty is a variant or brand not given. The category is the model's call, not a typed word, so it is exempt. A mention that fails any check is dropped whole.
   */
  private static accept(item: z.infer<typeof AnthropicMentionReader.ITEM>, typed: { squashed: string; words: string[] }): Mention | undefined {
    const fromTyped = (part: string) => {
      const squashed = AnthropicMentionReader.squashed(part)
      if (squashed === '') return false
      const words = normaliseText(part).split(' ').sort()
      const reordered = typed.words.some((_, start) => typed.words.slice(start, start + words.length).sort().join(' ') === words.join(' '))
      return typed.squashed.includes(squashed) || reordered
    }
    const name = AnthropicMentionReader.cleanText(item.name)
    if (!name || !fromTyped(name)) return undefined
    if (item.kind === 'ingredient') return { kind: 'ingredient', name }

    const brand = AnthropicMentionReader.cleanText(item.brand)
    const variant = AnthropicMentionReader.cleanText(item.variant)
    if (brand === undefined || variant === undefined || (brand !== '' && !fromTyped(brand)) || (variant !== '' && !fromTyped(variant))) return undefined
    const category = AnthropicMentionReader.CATEGORIES.find((known) => known === item.category) ?? null
    return { kind: 'product', brand: brand === '' ? null : brand, name, ...(variant === '' ? {} : { variant }), category }
  }
}

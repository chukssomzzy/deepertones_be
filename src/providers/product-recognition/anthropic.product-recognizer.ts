import { z } from 'zod'
import { base64Of } from '../../lib/base64'
import { hasLinkOrMarkup } from '../../lib/text-safety'
import { productRecognizerRecognizePrompt, productRecognizerRecognizeShelfPrompt, productRecognizerRecognizeShelfProductPrompt } from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import { PRODUCT_FORMS, type ProductCategory, type ProductForm } from '../product-research/product-researcher.provider'
import type { ProductRecognizer, Recognition, ShelfProduct, ShelfProductTarget, ShelfRecognition } from './product-recognizer.provider'

type Answer = {
  classification: 'beauty-product' | 'other-product' | 'face-or-person' | 'unreadable' | 'label-not-visible'
  brand: string
  name: string
  variant: string
  form: ProductForm | 'unknown'
  category: ProductCategory
  confidence: number
}

type ShelfAnswer = {
  classification: 'beauty-product' | 'other-product' | 'face-or-person' | 'unreadable'
  products: (Omit<Answer, 'classification'> & { position: string })[]
  excluded: { otherProducts: number; unreadable: number }
}

/** Names the product in a photo with Claude. The model is not trusted: anything out of bounds is `unreadable`. */
export class AnthropicProductRecognizer implements ProductRecognizer {
  // Haiku 5.5's adaptive thinking counts against max_tokens: a small budget can be spent thinking and cut the answer off.
  private static readonly MAX_TOKENS = 4096
  private static readonly MAX_FIELD_LENGTH = 120
  // Control characters and invisible format characters (a right-to-left override, a zero-width space) can disguise a name.
  private static readonly HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u
  private static readonly UNREADABLE: Recognition = { classification: 'unreadable' }

  private static readonly CLASSIFICATIONS = ['beauty-product', 'other-product', 'face-or-person', 'unreadable', 'label-not-visible'] as const
  private static readonly CATEGORIES = ['skin', 'hair', 'body', 'makeup', 'other'] as const satisfies readonly ProductCategory[]
  private static readonly FORMS = [...PRODUCT_FORMS, 'unknown'] as const

  // Every field is required and the object is closed, as structured outputs need. The three text fields also accept a
  // missing value, read as empty, so a model that leaves one out gets `unreadable` rather than a failed call. Shared by both
  // schemas, so a field added for one product is added for a shelf's too.
  private static readonly PRODUCT_FIELDS = {
    brand: AnthropicProductRecognizer.orEmpty(z.string()),
    name: AnthropicProductRecognizer.orEmpty(z.string()),
    variant: AnthropicProductRecognizer.orEmpty(z.string().describe('Empty when the packaging prints no variant')),
    // A missing form is read as unknown; the JSON schema sent to the API still requires it.
    form: z.preprocess((value) => value ?? 'unknown', z.enum(AnthropicProductRecognizer.FORMS)),
    category: z.enum(AnthropicProductRecognizer.CATEGORIES),
    confidence: z.number().describe('From 0 to 1'),
  }

  private static readonly SCHEMA = z.object({
    classification: z.enum(AnthropicProductRecognizer.CLASSIFICATIONS),
    ...AnthropicProductRecognizer.PRODUCT_FIELDS,
  })

  private static readonly SHELF_MAX_PRODUCTS = 5
  private static readonly SHELF_MAX_COUNT = 50

  private static readonly SHELF_SCHEMA = z.object({
    classification: z.enum(['beauty-product', 'other-product', 'face-or-person', 'unreadable']),
    products: z.array(
      z.object({
        position: AnthropicProductRecognizer.orEmpty(z.string().describe('Where the product sits in the photo, in a few words')),
        ...AnthropicProductRecognizer.PRODUCT_FIELDS,
      }),
    ),
    excluded: z.object({
      otherProducts: z.number().describe('Products that are not beauty or personal care'),
      unreadable: z.number().describe('Beauty or personal-care products whose brand or name cannot be read'),
    }),
  })

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async recognize(image: ProductImage): Promise<Recognition> {
    const answer = await this.client.structured(
      {
        max_tokens: AnthropicProductRecognizer.MAX_TOKENS,
        system: productRecognizerRecognizePrompt.text,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: base64Of(image.bytes) } },
              { type: 'text', text: 'Which product is in this photo?' },
            ],
          },
        ],
      },
      AnthropicProductRecognizer.SCHEMA,
      { job: productRecognizerRecognizePrompt.job },
    )
    return AnthropicProductRecognizer.accept(answer)
  }

  async recognizeShelf(image: ProductImage): Promise<ShelfRecognition> {
    const answer = await this.client.structured(
      {
        max_tokens: AnthropicProductRecognizer.MAX_TOKENS,
        system: productRecognizerRecognizeShelfPrompt.text,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: base64Of(image.bytes) } },
              { type: 'text', text: 'Which products are on this shelf?' },
            ],
          },
        ],
      },
      AnthropicProductRecognizer.SHELF_SCHEMA,
      { job: productRecognizerRecognizeShelfPrompt.job },
    )
    return AnthropicProductRecognizer.acceptShelf(answer)
  }

  async recognizeShelfProduct(image: ProductImage, target: ShelfProductTarget): Promise<Recognition> {
    // JSON.stringify, so a quote or newline in the position or hint cannot break out of the sentence.
    const text = `Read the product at this position: ${JSON.stringify(target.position)}. A quick read of the shelf gave: ${JSON.stringify(AnthropicProductRecognizer.hintOf(target.hint))}.`
    const answer = await this.client.structured(
      {
        max_tokens: AnthropicProductRecognizer.MAX_TOKENS,
        system: productRecognizerRecognizeShelfProductPrompt.text,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: base64Of(image.bytes) } },
              { type: 'text', text },
            ],
          },
        ],
      },
      AnthropicProductRecognizer.SCHEMA,
      { job: productRecognizerRecognizeShelfProductPrompt.job },
    )
    return AnthropicProductRecognizer.accept(answer)
  }

  /** The hint's fields in a fixed order, the variant left out when absent. */
  private static hintOf(hint: ShelfProductTarget['hint']) {
    return { brand: hint.brand, name: hint.name, ...(hint.variant === undefined ? {} : { variant: hint.variant }) }
  }

  private static orEmpty<T extends z.ZodType<string>>(schema: T) {
    return z.preprocess((value) => value ?? '', schema)
  }

  /** A trimmed string no longer than the bound and free of hidden characters, links and markup, or undefined. An empty string stays empty. */
  private static cleanText(value: string): string | undefined {
    const text = value.trim()
    return text.length <= AnthropicProductRecognizer.MAX_FIELD_LENGTH && !AnthropicProductRecognizer.HIDDEN_CHARACTER.test(text) && !hasLinkOrMarkup(text)
      ? text
      : undefined
  }

  private static accept(answer: Answer): Recognition {
    if (answer.classification !== 'beauty-product') return { classification: answer.classification }
    const product = AnthropicProductRecognizer.acceptProduct(answer)
    if (!product) return AnthropicProductRecognizer.UNREADABLE
    // A single scan has no position to give.
    const { position: _position, ...read } = product
    return { classification: 'beauty-product', ...read }
  }

  /** The product with clean text and a clamped confidence, or undefined when any text field is out of bounds. */
  private static acceptProduct(answer: Omit<Answer, 'classification'> & { position?: string }): ShelfProduct | undefined {
    const brand = AnthropicProductRecognizer.cleanText(answer.brand)
    const name = AnthropicProductRecognizer.cleanText(answer.name)
    const variant = AnthropicProductRecognizer.cleanText(answer.variant)
    if (!brand || !name || variant === undefined || Number.isNaN(answer.confidence)) return undefined
    return {
      // Only aims a second look, so a bad one is blanked and the product kept.
      position: AnthropicProductRecognizer.cleanText(answer.position ?? '') ?? '',
      brand,
      name,
      ...(variant === '' ? {} : { variant }),
      ...(answer.form === 'unknown' ? {} : { form: answer.form }),
      category: answer.category,
      confidence: Math.min(1, Math.max(0, answer.confidence)),
    }
  }

  private static clampCount(value: number): number {
    return Math.min(AnthropicProductRecognizer.SHELF_MAX_COUNT, Math.max(0, Math.floor(value)))
  }

  /** Bad products are dropped and counted unreadable; the limit is applied after, so a dropped one takes no place. Cut products are counted nowhere. */
  private static acceptShelf(answer: ShelfAnswer): ShelfRecognition {
    const accepted = answer.products.flatMap((item) => AnthropicProductRecognizer.acceptProduct(item) ?? [])
    const dropped = answer.products.length - accepted.length
    // Array.prototype.sort is stable, so equal confidences keep the model's order.
    const products = accepted.sort((a, b) => b.confidence - a.confidence).slice(0, AnthropicProductRecognizer.SHELF_MAX_PRODUCTS)
    const excluded = {
      otherProducts: AnthropicProductRecognizer.clampCount(answer.excluded.otherProducts),
      unreadable: AnthropicProductRecognizer.clampCount(AnthropicProductRecognizer.clampCount(answer.excluded.unreadable) + dropped),
    }
    if (products.length > 0) return { classification: 'beauty-product', products, excluded }
    return { classification: answer.classification === 'beauty-product' ? 'unreadable' : answer.classification, products, excluded }
  }
}

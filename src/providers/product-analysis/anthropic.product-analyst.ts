import { z } from 'zod'
import { base64Of } from '../../lib/base64'
import {
  productAnalystAnalysePrompt,
  productAnalystImageCheckPrompt,
  productAnalystSameProductPrompt,
} from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import type { ProductIdentity } from '../product-research/product-researcher.provider'
import type { AnalysisInput, DraftConcern, ProductAnalyst, ProductImage } from './product-analyst.provider'

/** Judges products with Claude, using structured outputs so every answer has a fixed shape. */
export class AnthropicProductAnalyst implements ProductAnalyst {
  // Adaptive thinking on Sonnet 5.5 counts against max_tokens, so these leave room for it: a budget
  // sized to the visible answer alone can be spent thinking and cut the JSON off (a max_tokens error).
  private static readonly ANALYSE_MAX_TOKENS = 16000
  // The yes/no answers run on Haiku 5.5 by default, whose adaptive thinking also counts against max_tokens: a small budget can be
  // spent thinking and cut the answer off.
  private static readonly ANSWER_MAX_TOKENS = 4096
  // The schema cannot carry maxLength, so the length budget goes in the descriptions as well as the system prompt (the analyse
  // prompt's placeholders are filled from these two, so the limits have one source). It sits well under the gate in
  // catalog.analysis.ts so that a model running a little long is still accepted.
  private static readonly WHY_GUIDANCE = '2-3 sentences, at most 450 characters'
  private static readonly WHO_GUIDANCE = 'One sentence, at most 200 characters'

  /*
   * Structured outputs accept a limited JSON Schema: every object must set additionalProperties:
   * false (zod's object does), and length, range and count keywords (min, max, length...) are
   * rejected, so none are used in the schemas below.
   */
  private static readonly SAME_SCHEMA = z.object({ same: z.boolean() })
  private static readonly MATCHES_SCHEMA = z.object({ matches: z.boolean() })

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async analyse(input: AnalysisInput): Promise<DraftConcern[]> {
    const { product, ingredients } = input
    // A null source is left out, so the prompt never shows a source the model could mistake for a URL.
    const flaggedFacts = input.flaggedFacts.map(({ source, ...fact }) => (source === null ? fact : { ...fact, source }))
    const { concerns } = await this.client.structured(
      {
        max_tokens: AnthropicProductAnalyst.ANALYSE_MAX_TOKENS,
        system: productAnalystAnalysePrompt.render({
          whyGuidance: AnthropicProductAnalyst.WHY_GUIDANCE,
          whoGuidance: AnthropicProductAnalyst.WHO_GUIDANCE,
        }),
        messages: [{ role: 'user', content: `Analyse this product:\n${JSON.stringify({ product, ingredients, flaggedFacts })}` }],
      },
      AnthropicProductAnalyst.analyseSchema(input),
      { job: productAnalystAnalysePrompt.job },
    )
    return concerns
  }

  async sameProduct(a: ProductIdentity, b: ProductIdentity): Promise<boolean> {
    const { same } = await this.client.structured(
      {
        max_tokens: AnthropicProductAnalyst.ANSWER_MAX_TOKENS,
        system: productAnalystSameProductPrompt.text,
        messages: [{ role: 'user', content: `Are these the same product?\n${JSON.stringify({ a, b })}` }],
      },
      AnthropicProductAnalyst.SAME_SCHEMA,
      { job: productAnalystSameProductPrompt.job },
    )
    return same
  }

  async imageShowsProduct(image: ProductImage, product: ProductIdentity): Promise<boolean> {
    const { matches } = await this.client.structured(
      {
        max_tokens: AnthropicProductAnalyst.ANSWER_MAX_TOKENS,
        system: productAnalystImageCheckPrompt.text,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: base64Of(image.bytes) } },
              { type: 'text', text: `Does the image show this product?\n${JSON.stringify(product)}` },
            ],
          },
        ],
      },
      AnthropicProductAnalyst.MATCHES_SCHEMA,
      { job: productAnalystImageCheckPrompt.job },
    )
    return matches
  }

  // The caller owns the vocabularies, so the enums are built per call. z.enum wants a non-empty tuple.
  private static analyseSchema(input: AnalysisInput) {
    const values = (list: readonly string[]) => z.enum([...list] as [string, ...string[]])
    return z.object({
      concerns: z.array(
        z.object({
          kind: values(input.kinds),
          severity: values(input.severities),
          ingredients: z.array(z.string()),
          why: z.string().describe(AnthropicProductAnalyst.WHY_GUIDANCE),
          whoShouldTakeCare: z.string().describe(AnthropicProductAnalyst.WHO_GUIDANCE),
          traits: z.array(values(input.traits)),
          sources: z.array(z.string()),
        }),
      ),
    })
  }
}

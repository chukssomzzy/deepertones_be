import { z } from 'zod'
import { verdictFitterFitVerdictPrompt } from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import { AnthropicRequestError } from '../anthropic/anthropic.provider'
import type { FitRequest, FitResult, VerdictFitter } from './verdict-fitter.provider'

// What is sent to Claude. The shape is checked here; that the answer fits the shelf is checked in `checked`. The pair is a plain list of strings, not a
// tuple, because the API refused an empty tuple's `prefixItems` (see AnthropicRoutineWriter's schema) and a length is checked below anyway.
const FitResultSchema = z.object({
  products: z.array(z.object({ id: z.string(), label: z.enum(['helping', 'redundant', 'blocking']), reason: z.string() })),
  clashes: z.array(z.object({ ids: z.array(z.string()), reduceId: z.string() })),
})

const pairKey = (a: string, b: string): string => JSON.stringify([a, b].sort())

/**
 * Judges a shelf with Claude, in one call. It checks the answer against the request and throws `AnthropicRequestError` for one that does not fit, so there is
 * never a partial result: exactly one entry for each open product and none for a fixed one, and every clash entry is one of the request's pairs, answered once,
 * with a product of that pair to reduce that is not prescribed. A pair the answer leaves out is not an error: the floor settles it. It logs nothing: the request
 * is a person's shelf and the reply is the model's words.
 */
export class AnthropicVerdictFitter implements VerdictFitter {
  // Sonnet's adaptive thinking counts against max_tokens, and a reason for each product on a full shelf runs to a few thousand tokens.
  private static readonly MAX_TOKENS = 8192
  private static readonly LEAD_IN = 'Judge the fit of this shelf:'

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async fit(request: FitRequest): Promise<FitResult> {
    const answer = await this.client.structured(
      {
        max_tokens: AnthropicVerdictFitter.MAX_TOKENS,
        system: verdictFitterFitVerdictPrompt.text,
        messages: [{ role: 'user', content: [{ type: 'text', text: `${AnthropicVerdictFitter.LEAD_IN}\n${JSON.stringify(request)}` }] }],
      },
      FitResultSchema,
      { job: verdictFitterFitVerdictPrompt.job },
    )
    return AnthropicVerdictFitter.checked(request, answer)
  }

  private static checked(request: FitRequest, answer: z.infer<typeof FitResultSchema>): FitResult {
    const open = new Set(request.shelf.filter((p) => p.floor.status === 'open').map((p) => p.id))
    const answered = new Set(answer.products.map((p) => p.id))
    if (answered.size !== answer.products.length || answered.size !== open.size || ![...answered].every((id) => open.has(id))) {
      throw new AnthropicRequestError('Claude did not label exactly the open products on the shelf')
    }

    const asked = new Set(request.clashes.map(({ ids: [a, b] }) => pairKey(a, b)))
    const prescribed = new Set(request.shelf.filter((p) => p.floor.status === 'fixed' && p.floor.group === 'prescribed').map((p) => p.id))
    const settled = new Set<string>()
    const clashes = answer.clashes.map(({ ids, reduceId }): FitResult['clashes'][number] => {
      const [a, b] = ids
      if (ids.length !== 2 || a === undefined || b === undefined) throw new AnthropicRequestError('Claude answered a clash that is not a pair')
      const key = pairKey(a, b)
      if (!asked.has(key) || settled.has(key)) throw new AnthropicRequestError('Claude answered a clash that was not asked about, or answered one twice')
      if (reduceId !== a && reduceId !== b) throw new AnthropicRequestError('Claude chose a product to reduce that is not in its pair')
      if (prescribed.has(reduceId)) throw new AnthropicRequestError('Claude chose a prescribed product to reduce, and a prescribed product is always kept')
      settled.add(key)
      return { ids: [a, b], reduceId }
    })

    return { products: answer.products, clashes }
  }
}

import { z } from 'zod'
import { verdictFitterFitVerdictPrompt } from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import { AnthropicRequestError } from '../anthropic/anthropic.provider'
import type { FitProductResult, FitRequest, FitResult, VerdictFitter } from './verdict-fitter.provider'

// What is sent to Claude. The shape is checked here; that the answer fits the shelf is checked in `checked`. The pair is a plain list of strings, not a
// tuple, because the API refused an empty tuple's `prefixItems` (see AnthropicRoutineWriter's schema) and a length is checked below anyway.
const FitResultSchema = z.object({
  // sameJobAs is required and nullable rather than optional: structured outputs want every field present, and a flat object keeps the schema free of oneOf.
  products: z.array(z.object({ id: z.string(), label: z.enum(['helping', 'redundant', 'blocking']), reason: z.string(), sameJobAs: z.string().nullable() })),
  clashes: z.array(z.object({ ids: z.array(z.string()), reduceId: z.string() })),
})

const pairKey = (a: string, b: string): string => JSON.stringify([a, b].sort())

/**
 * Judges a shelf with Claude, in one call. It checks the answer against the request and throws `AnthropicRequestError` for one that does not fit, so there is
 * never a partial result: exactly one entry for each open product and none for a fixed one, each with a reason that is not empty and at most 200 characters,
 * a redundant one naming (`sameJobAs`) a product that stays (an open one this answer labels helping, or a prescribed fixed one) and no other label naming any, and
 * every clash entry is one of the request's pairs, answered once, returned in the request's order of ids, with a product of that pair to reduce that is not
 * prescribed. A pair the answer leaves out is not an error: the floor settles it. It logs nothing: the request is a person's shelf and the reply is the model's words.
 */
export class AnthropicVerdictFitter implements VerdictFitter {
  // Sonnet's adaptive thinking counts against max_tokens, and a reason for each product on a full shelf runs to a few thousand tokens.
  private static readonly MAX_TOKENS = 8192
  private static readonly MAX_REASON_LENGTH = 200
  private static readonly LEAD_IN = 'Judge the fit of this shelf:'

  private readonly client: AnthropicClient
  readonly identity: VerdictFitter['identity']

  constructor(client: AnthropicClient) {
    this.client = client
    this.identity = { model: client.modelFor(verdictFitterFitVerdictPrompt.job), promptHash: verdictFitterFitVerdictPrompt.hash }
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

    const asked = new Map(request.clashes.map(({ ids }) => [pairKey(...ids), ids]))
    const prescribed = new Set(request.shelf.filter((p) => p.floor.status === 'fixed' && p.floor.group === 'prescribed').map((p) => p.id))

    const kept = new Set([...prescribed, ...answer.products.filter((p) => p.label === 'helping').map((p) => p.id)])
    const products = answer.products.map((p): FitProductResult => {
      const reason = p.reason.trim()
      if (reason === '' || reason.length > AnthropicVerdictFitter.MAX_REASON_LENGTH) {
        throw new AnthropicRequestError(`Claude gave a reason that is empty or over ${AnthropicVerdictFitter.MAX_REASON_LENGTH} characters`)
      }
      if (p.label !== 'redundant') {
        if (p.sameJobAs !== null) throw new AnthropicRequestError('Claude named a product that does the same job for a product that is not redundant')
        return { id: p.id, label: p.label, reason, sameJobAs: null }
      }
      if (p.sameJobAs === null || !kept.has(p.sameJobAs)) {
        throw new AnthropicRequestError('Claude called a product redundant without naming a product that stays: a helping open product or a prescribed one')
      }
      return { id: p.id, label: 'redundant', reason, sameJobAs: p.sameJobAs }
    })

    const settled = new Set<string>()
    const clashes = answer.clashes.map(({ ids, reduceId }): FitResult['clashes'][number] => {
      const [a, b] = ids
      if (ids.length !== 2 || a === undefined || b === undefined) throw new AnthropicRequestError('Claude answered a clash that is not a pair')
      const key = pairKey(a, b)
      const askedIds = asked.get(key)
      if (!askedIds || settled.has(key)) throw new AnthropicRequestError('Claude answered a clash that was not asked about, or answered one twice')
      if (reduceId !== a && reduceId !== b) throw new AnthropicRequestError('Claude chose a product to reduce that is not in its pair')
      if (prescribed.has(reduceId)) throw new AnthropicRequestError('Claude chose a prescribed product to reduce, and a prescribed product is always kept')
      settled.add(key)
      return { ids: askedIds, reduceId }
    })

    return { products, clashes }
  }
}

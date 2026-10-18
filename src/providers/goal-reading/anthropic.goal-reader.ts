import { z } from 'zod'
import { GOALS } from '../../modules/goals/goals.vocabulary'
import { goalReaderReadGoalPrompt } from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import type { GoalReader, GoalReading } from './goal-reader.provider'

/** Sorts typed words into one of the six goals with Claude. The model is not trusted: a reply off the schema is "no goal", not a failed call. */
export class AnthropicGoalReader implements GoalReader {
  // Haiku 5.5's adaptive thinking counts against max_tokens: a small budget can be spent thinking and cut the answer off.
  private static readonly MAX_TOKENS = 4096
  private static readonly NO_GOAL: GoalReading = { goal: null, wantsLighter: false }

  private static readonly REPLIES = [...GOALS, 'none'] as const

  // Every field is required and the object is closed, as structured outputs need. The schema has no null, so the model says "none".
  // The leniency is in the parse and none of it reaches the schema sent (a root `catch` would add a `default`, which the API does not take):
  // a field that does not fit parses as absent (which is why `catch` is given undefined, though the type says otherwise; accept checks
  // it), and a reply that is not an object is read as an empty one. Either way the result is no goal, not a failed call.
  private static readonly SCHEMA = z.preprocess(
    (reply) => (reply !== null && typeof reply === 'object' && !Array.isArray(reply) ? reply : {}),
    z.object({
      goal: z.enum(AnthropicGoalReader.REPLIES).catch(undefined as never),
      wantsLighter: z.boolean().catch(undefined as never),
    }),
  )

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async read(text: string): Promise<GoalReading> {
    const answer = await this.client.structured(
      {
        max_tokens: AnthropicGoalReader.MAX_TOKENS,
        system: goalReaderReadGoalPrompt.text,
        messages: [{ role: 'user', content: [{ type: 'text', text: text.trim() }] }],
      },
      AnthropicGoalReader.SCHEMA,
      { job: goalReaderReadGoalPrompt.job },
    )
    if (!AnthropicGoalReader.REPLIES.includes(answer.goal) || typeof answer.wantsLighter !== 'boolean') return AnthropicGoalReader.NO_GOAL
    // Asking to be lighter is always the brighter goal, whatever goal the model put with it; the app answers it kindly.
    if (answer.wantsLighter) return { goal: 'brighter', wantsLighter: true }
    return answer.goal === 'none' ? AnthropicGoalReader.NO_GOAL : { goal: answer.goal, wantsLighter: false }
  }
}

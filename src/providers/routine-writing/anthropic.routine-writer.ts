import { RoutineSchema } from '../../modules/routines/routines.schema'
import type { Routine, RoutineSkeleton } from '../../modules/routines/routines.types'
import { routineWriterWriteRoutinePrompt } from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import type { RoutineWriter } from './routine-writer.provider'

/**
 * Writes a routine for a skeleton with Claude. It does not run the gates: it checks only that the reply parses as `RoutineSchema`
 * (the client throws `AnthropicRequestError` for one that does not, so there is never a partial routine), and the caller runs `checkRoutine` on it before anything uses it.
 * It logs nothing: the skeleton and the reply are a person's shelf and the model's words.
 */
export class AnthropicRoutineWriter implements RoutineWriter {
  // Sonnet's adaptive thinking counts against max_tokens, and a routine plus its reasons runs to a few thousand tokens.
  private static readonly MAX_TOKENS = 8192
  private static readonly LEAD_IN = 'Write the routine for this skeleton:'

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async write(skeleton: RoutineSkeleton): Promise<Routine> {
    return this.client.structured(
      {
        max_tokens: AnthropicRoutineWriter.MAX_TOKENS,
        system: routineWriterWriteRoutinePrompt.text,
        messages: [{ role: 'user', content: [{ type: 'text', text: `${AnthropicRoutineWriter.LEAD_IN}\n${JSON.stringify(skeleton)}` }] }],
      },
      RoutineSchema,
      { job: routineWriterWriteRoutinePrompt.job },
    )
  }
}

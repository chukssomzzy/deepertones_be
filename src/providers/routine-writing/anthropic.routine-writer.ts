import { RoutineSchema, routineSchemaFor } from '../../modules/routines/routines.schema'
import type { Routine, RoutineSkeleton } from '../../modules/routines/routines.types'
import { routineWriterWriteRoutinePrompt } from '../../prompts/prompts.generated'
import type { AnthropicClient } from '../anthropic/anthropic.client'
import { AnthropicRequestError } from '../anthropic/anthropic.provider'
import type { RoutineWriter } from './routine-writer.provider'

/**
 * Writes a routine for a skeleton with Claude. It does not run the gates: it checks only that the reply parses as `RoutineSchema`, narrowed to
 * the skeleton's own products (one that does not is an `AnthropicRequestError`, so there is never a partial routine), and the caller runs `checkRoutine` on it before anything uses it.
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
    const routine = await this.client.structured(
      {
        max_tokens: AnthropicRoutineWriter.MAX_TOKENS,
        system: routineWriterWriteRoutinePrompt.text,
        messages: [{ role: 'user', content: [{ type: 'text', text: `${AnthropicRoutineWriter.LEAD_IN}\n${JSON.stringify(skeleton)}` }] }],
      },
      routineSchemaFor(skeleton),
      { job: routineWriterWriteRoutinePrompt.job },
    )
    // The narrowed schema only accepts what the contract accepts; checking again keeps that true if either changes.
    const parsed = RoutineSchema.safeParse(routine)
    if (!parsed.success) throw new AnthropicRequestError('Claude returned a routine that does not match the Routine contract')
    return parsed.data
  }
}

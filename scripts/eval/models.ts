import type { AiJob } from '../../src/providers/anthropic/ai-spend.provider'

/**
 * The model each job runs on in the eval: the same split as the top-level ANTHROPIC_MODEL_* vars in wrangler.jsonc, a
 * cheap model for the internal steps and a better one for the text users read. models.test.ts fails if they drift.
 */
export const DEFAULT_MODELS: Record<AiJob, string> = {
  research: 'claude-haiku-5-5',
  'same-product': 'claude-haiku-5-5',
  'image-check': 'claude-haiku-5-5',
  recognize: 'claude-haiku-5-5',
  'read-label': 'claude-haiku-5-5',
  'split-name': 'claude-haiku-5-5',
  'read-goal': 'claude-haiku-5-5',
  analysis: 'claude-sonnet-5-5',
}

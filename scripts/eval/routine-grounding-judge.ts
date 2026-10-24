/*
 * The page-support judge of `npm run eval:routine`: for one grounding link of one routine entry, one Claude call that may fetch that page (and only that page) and
 * says whether it supports the entry's reason. It mirrors the catalog eval's AnthropicDraftJudge and shares its fetch tool and its fetch check. Its score is
 * reported but is not in the bar. It lives with the eval, not in src/providers, because nothing in the product asks it anything.
 */
import { z } from 'zod'
import type { RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import { comparableUrl } from '../../src/lib/url-safety'
import { routineGroundingJudgeJudgeGroundingPrompt } from '../../src/prompts/prompts.generated'
import { AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import type { AnthropicClient } from '../../src/providers/anthropic/anthropic.client'
import { AnthropicConfigError, lastJsonObjectIn, textOf } from '../../src/providers/anthropic/anthropic.provider'
import type { UnverifiableReason } from './draft-score'
import { fetchOutcomeOf, hostOf, pageFetchTool } from './draft-judge'

export type GroundingRequest = {
  step: RoutineStep
  /** The entry's reason: what the page is checked against. */
  reason: string
  /** The page the entry cited. */
  sourceUrl: string
}

/** What the judge said of one link. `reason` is only given when `fetched` is false, and is a fixed code. */
export type GroundingVerdict = { fetched: boolean; supports: 'yes' | 'no' | 'unclear'; reason?: UnverifiableReason }

export interface GroundingJudge {
  /** Never throws for a link it cannot vouch for (that is an "unverifiable" verdict); throws AiBudgetExceededError at the spend cap and AnthropicConfigError for a key, billing or permission that is wrong. */
  judge(request: GroundingRequest): Promise<GroundingVerdict>
}

/** What a verdict that vouches for nothing looks like, with why. */
export const unverifiableGrounding = (reason: UnverifiableReason): GroundingVerdict => ({ fetched: false, supports: 'unclear', reason })

// What of the answer matters here: its two fields. Anything else the model wrote (reasoning, a quote from the page) is dropped by the parse.
const ANSWER_SCHEMA = z.object({ fetched: z.boolean(), supports: z.enum(['yes', 'no', 'unclear']) })

/** Checks one routine entry's reason against its cited page with Claude and its web fetch tool. */
export class AnthropicGroundingJudge implements GroundingJudge {
  private static readonly MAX_TOKENS = 4096

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async judge(request: GroundingRequest): Promise<GroundingVerdict> {
    // The tool is restricted to the cited page's host, and only a fetch of that very page counts below, so the verdict is about the page the entry cited.
    const host = hostOf(request.sourceUrl)
    const cited = comparableUrl(request.sourceUrl)
    if (host === undefined || cited === undefined) return unverifiableGrounding('not-fetched')

    let message
    try {
      message = await this.client.createMessage(
        {
          max_tokens: AnthropicGroundingJudge.MAX_TOKENS,
          system: routineGroundingJudgeJudgeGroundingPrompt.text,
          // The fetch tool only fetches a page it has already seen in the conversation, so the address goes in the message as the routine gave it.
          messages: [{ role: 'user', content: `Judge whether this page supports this reason:\n${JSON.stringify(request)}` }],
          tools: [pageFetchTool(host)],
        },
        { job: routineGroundingJudgeJudgeGroundingPrompt.job },
      )
    } catch (error) {
      // These end the run, not just this link: the cap, and a key, billing or permission that is wrong (every later link would fail the same way).
      if (error instanceof AiBudgetExceededError || error instanceof AnthropicConfigError) throw error
      return unverifiableGrounding('api-error')
    }

    if (message.stop_reason === 'refusal') return unverifiableGrounding('refused')
    if (message.stop_reason === 'max_tokens') return unverifiableGrounding('cut-off')
    const outcome = fetchOutcomeOf(message, cited)
    if (outcome !== 'fetched') return unverifiableGrounding(outcome)

    const answer = lastJsonObjectIn(textOf(message), ANSWER_SCHEMA)
    if (!answer) return unverifiableGrounding('unreadable-answer')
    if (!answer.fetched) return unverifiableGrounding('not-fetched')
    return { fetched: true, supports: answer.supports }
  }
}

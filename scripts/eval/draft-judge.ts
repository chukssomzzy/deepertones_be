/*
 * The judge of `npm run eval:catalog -- --mode draft`: for one drafted value and the page it cites, one Claude call that may fetch that page (and only
 * that page) and says whether it was fetched, whether it is about the exact product, and whether it supports the value. It lives with the eval, not in
 * src/providers, because nothing in the product asks it anything.
 */
import { z } from 'zod'
import { comparableUrl } from '../../src/lib/url-safety'
import { draftJudgeJudgeDraftPrompt } from '../../src/prompts/prompts.generated'
import { AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import type { AnthropicClient } from '../../src/providers/anthropic/anthropic.client'
import { AnthropicConfigError, lastJsonObjectIn, type Message, textOf } from '../../src/providers/anthropic/anthropic.provider'
import type { ProductIdentity } from '../../src/providers/product-research/product-researcher.provider'
import type { Column, UnverifiableReason, Verdict } from './draft-score'

/** A price row as the judge is shown it: the currency is the one its country's Countries row says, so the judge can check the page against it. */
export type PriceValue = { country: string; currency: string; priceMin: number; priceMax: number; whereSold?: string }

export type JudgeRequest = {
  product: ProductIdentity
  column: Column | 'availability'
  value: string | string[] | PriceValue
  /** The page the drafter cited for the value. */
  sourceUrl: string
}

export interface DraftJudge {
  /** Never throws for a value it cannot vouch for (that is an "unverifiable" verdict); throws AiBudgetExceededError at the spend cap and AnthropicConfigError for a key, billing or permission that is wrong. */
  judge(request: JudgeRequest): Promise<Verdict>
}

/** What a verdict that vouches for nothing looks like, with why. */
export const unverifiable = (reason: UnverifiableReason): Verdict => ({ fetched: false, exactProduct: 'unclear', supports: 'unclear', currencyShown: null, reason })

// What of the answer matters here: its five fields. Anything else the model wrote (reasoning, a quote from the page) is dropped by the parse.
const ANSWER_SCHEMA = z.object({
  fetched: z.boolean(),
  exactProduct: z.enum(['yes', 'no', 'unclear']),
  supports: z.enum(['yes', 'no', 'unclear']),
  currencyShown: z.string().nullable().optional(),
  // Kept loose and cleaned by hand below: a malformed list must cost only the prices, not the verdict.
  pricesShown: z.unknown().optional(),
})

const CURRENCY_CODE = /^[A-Z]{3}$/

/** The prices worth comparing: positive whole numbers small enough to be exact. Anything else the judge wrote in the list is dropped. */
const pricesIn = (shown: unknown): number[] => (Array.isArray(shown) ? shown.filter((price): price is number => typeof price === 'number' && Number.isSafeInteger(price) && price > 0) : [])

export const hostOf = (address: string): string | undefined => {
  try {
    return new URL(address).hostname
  } catch {
    return undefined
  }
}

// The page was cited, so one fetch is the job; the second is for a retry. A fetched page is billed as input tokens, so what a fetch may bring in is bounded too.
const MAX_FETCHES = 2
const MAX_PAGE_TOKENS = 20_000

/** The web fetch tool of a judge that reads one cited page: restricted to that page's host, so it cannot read another site. */
export const pageFetchTool = (host: string) => ({
  type: 'web_fetch_20260318',
  name: 'web_fetch',
  max_uses: MAX_FETCHES,
  max_content_tokens: MAX_PAGE_TOKENS,
  allowed_domains: [host],
  // One plain fetch is the job. By default this tool version runs through code execution (dynamic filtering), whose fetch results may not come back as top-level blocks for the check below.
  allowed_callers: ['direct'],
})

/**
 * Whether a reply holds a successful fetch of exactly the cited page (compared by `comparableUrl`), and if it does not, why: 'fetch-failed' when fetches were made
 * and none succeeded, 'not-fetched' when none was made or only other pages were fetched. A judge that says it read the page without a result like this is not taken at its word.
 */
export const fetchOutcomeOf = (message: Message, cited: string): 'fetched' | 'fetch-failed' | 'not-fetched' => {
  const results = message.content.flatMap((block) => (block.type === 'web_fetch_tool_result' ? [block.content as { type?: unknown; url?: unknown } | null | undefined] : []))
  const pages = results.filter((result) => result?.type === 'web_fetch_result')
  if (pages.length === 0) return results.length > 0 ? 'fetch-failed' : 'not-fetched'
  return pages.some((page) => typeof page?.url === 'string' && comparableUrl(page.url) === cited) ? 'fetched' : 'not-fetched'
}

/** Checks one drafted value against its cited page with Claude and its web fetch tool. */
export class AnthropicDraftJudge implements DraftJudge {
  private static readonly MAX_TOKENS = 4096

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async judge(request: JudgeRequest): Promise<Verdict> {
    // The tool is restricted to the cited page's host, and only a fetch of that very page counts below, so the verdict is about the page the drafter cited.
    const host = hostOf(request.sourceUrl)
    const cited = comparableUrl(request.sourceUrl)
    if (host === undefined || cited === undefined) return unverifiable('not-fetched')

    let message
    try {
      message = await this.client.createMessage(
        {
          max_tokens: AnthropicDraftJudge.MAX_TOKENS,
          system: draftJudgeJudgeDraftPrompt.text,
          // The fetch tool only fetches a page it has already seen in the conversation, so the address goes in the message as the drafter gave it.
          messages: [{ role: 'user', content: `Judge this drafted value:\n${JSON.stringify(request)}` }],
          tools: [pageFetchTool(host)],
        },
        { job: draftJudgeJudgeDraftPrompt.job },
      )
    } catch (error) {
      // These end the run, not just this value: the cap, and a key, billing or permission that is wrong (every later value would fail the same way).
      if (error instanceof AiBudgetExceededError || error instanceof AnthropicConfigError) throw error
      return unverifiable('api-error')
    }

    // A reply cut off or refused is not an answer. Neither is one the judge gives without having read the page: it is not taken at its word.
    if (message.stop_reason === 'refusal') return unverifiable('refused')
    if (message.stop_reason === 'max_tokens') return unverifiable('cut-off')
    const outcome = fetchOutcomeOf(message, cited)
    if (outcome !== 'fetched') return unverifiable(outcome)

    const answer = lastJsonObjectIn(textOf(message), ANSWER_SCHEMA)
    if (!answer) return unverifiable('unreadable-answer')
    if (!answer.fetched) return unverifiable('not-fetched')

    const shown = answer.currencyShown
    const isPriceRow = request.column === 'availability'
    return {
      fetched: true,
      exactProduct: answer.exactProduct,
      supports: answer.supports,
      // Only a price row has a currency to check, and only a currency code can be compared with the country's.
      currencyShown: isPriceRow && typeof shown === 'string' && CURRENCY_CODE.test(shown) ? shown : null,
      ...(isPriceRow ? { pricesShown: pricesIn(answer.pricesShown) } : {}),
    }
  }
}

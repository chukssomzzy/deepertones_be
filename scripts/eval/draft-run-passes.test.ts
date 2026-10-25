import { describe, expect, it, vi } from 'vitest'
import { BIG_CAP_MICROS } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import type { CatalogDrafter, DraftRequest } from '../../src/providers/catalog-drafting/catalog-drafter.provider'
import type { DraftCase } from './draft-cases'
import type { DraftJudge } from './draft-judge'
import { runDraftEval } from './draft-run'

// The eval decides for itself how many times to try for a price: it measures price coverage, and a number that moved whenever `catalog:draft`'s default
// moved would change what the eval measures without anyone choosing to. So here the drafting module's default is made a different number, and the eval's
// attempts must not follow it. (The mock changes only what draftWorkbook does when it is handed no `passes`.)
const CHANGED_DEFAULT = 7
const EVAL_PASSES = 3

vi.mock('../catalog/draft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../catalog/draft')>()
  return { ...actual, draftWorkbook: (input: Parameters<typeof actual.draftWorkbook>[0], deps: Parameters<typeof actual.draftWorkbook>[1]) => actual.draftWorkbook(input, { ...deps, passes: deps.passes ?? CHANGED_DEFAULT }) }
})

const NEVER_PRICED: DraftCase = { id: 'never-priced-lotion', kind: 'ordinary', product: { brand: 'Zelvo', name: 'Body Lotion', category: 'body' }, countries: ['NG', 'GB'] }

describe('runDraftEval: how many times it tries for a price', () => {
  it('asks for a price it never gets in three passes, whatever the default of catalog:draft is', async () => {
    const requests: DraftRequest[] = []
    const drafter: CatalogDrafter = {
      draft: async (request) => {
        requests.push(request)
        return { cells: {}, availability: [] }
      },
    }
    const judge: DraftJudge = { judge: async () => ({ fetched: false, exactProduct: 'unclear', supports: 'unclear' }) }

    await runDraftEval({
      cases: [NEVER_PRICED],
      startedAt: new Date('2030-06-15T00:00:00.000Z'),
      deps: { researcher: { research: async () => ({ found: false }) }, drafter, judge, ledger: new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS }) },
      io: { log: () => {}, mkdir: async () => {}, writeFile: async () => {}, writeWorkbook: async () => {} },
      outDir: 'out/passes',
    })

    expect(requests.map((request) => request.attempt ?? 1)).toEqual(Array.from({ length: EVAL_PASSES }, (_, i) => i + 1))
  })
})

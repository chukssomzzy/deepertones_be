import { describe, expect, it } from 'vitest'
import type { OpsAlertsRepository } from './ops-alerts.repository'
import type { OpsAlertKind } from './ops-alerts.types'

/**
 * The repository keeps ONE row per kind, which a newer window replaces, so a window that an earlier test (or an earlier RUN, on a
 * database that keeps its rows) already claimed, or one before it, would lose. Only the ORDER of windows matters to the repository
 * (it does not know how long a window is), so every window here is a few milliseconds after the last: each test takes its own block
 * of 10 ms, and the first block starts at the real clock when this file loads, which is later than any earlier run's last block.
 * That is the one use of the real clock in this file, and it is for ordering, not for any behaviour under test.
 */
const ORDER_ORIGIN = Date.now()
let block = 0
const nextWindows = () => {
  const first = new Date(ORDER_ORIGIN + 10 * block++ + 5)
  return { first, second: new Date(first.getTime() + 2) }
}

/**
 * Behaviour every OpsAlertsRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier).
 *
 * `claim(kind, windowStart)` is the whole interface: it says whether THIS caller is the one that gets to alert for that kind
 * in that window. On D1 it is one guarded upsert, so simultaneous callers cannot both win (a read followed by a write would
 * let both through). The repository does not know how long a window is; a window newer than the one stored wins.
 */
export const opsAlertsRepositoryContract = (name: string, make: () => OpsAlertsRepository | Promise<OpsAlertsRepository>) => {
  describe(`OpsAlertsRepository contract: ${name}`, () => {
    it('lets the first claim of a kind in a window win', async () => {
      const repo = await make()
      const { first } = nextWindows()

      expect(await repo.claim('ai-account', first)).toBe(true)
    })

    it('refuses a second claim of the same kind in the same window', async () => {
      const repo = await make()
      const { first } = nextWindows()
      await repo.claim('ai-account', first)

      expect(await repo.claim('ai-account', first)).toBe(false)
      expect(await repo.claim('ai-account', new Date(first.getTime()))).toBe(false)
    })

    it('lets a window one millisecond newer win, and then refuses it to the next caller', async () => {
      const repo = await make()
      const { first } = nextWindows()
      await repo.claim('ai-account', first)
      const newer = new Date(first.getTime() + 1)

      expect(await repo.claim('ai-account', newer)).toBe(true)
      expect(await repo.claim('ai-account', newer)).toBe(false)
    })

    it('refuses a window one millisecond older than the latest claimed, and does not reopen the newer one', async () => {
      const repo = await make()
      const { first, second } = nextWindows()
      await repo.claim('ai-account', second)

      expect(await repo.claim('ai-account', new Date(second.getTime() - 1))).toBe(false)
      expect(await repo.claim('ai-account', first)).toBe(false)
      expect(await repo.claim('ai-account', second)).toBe(false)
    })

    it('keeps each kind apart: claiming one kind in a window leaves the others free to claim it', async () => {
      const repo = await make()
      const { first } = nextWindows()
      const kinds: OpsAlertKind[] = ['ai-account', 'ai-spend-cap', 'research-budget', 'analysis-budget']

      for (const kind of kinds) expect(await repo.claim(kind, first), kind).toBe(true)
      for (const kind of kinds) expect(await repo.claim(kind, first), kind).toBe(false)
    })

    it('lets exactly one of a burst of simultaneous claims win', async () => {
      const repo = await make()
      const { first } = nextWindows()

      const results = await Promise.all(Array.from({ length: 8 }, () => repo.claim('ai-spend-cap', first)))

      expect(results.filter(Boolean)).toHaveLength(1)
    })

    it('lets exactly one of a burst of simultaneous claims of the next window win, after the earlier window was claimed', async () => {
      const repo = await make()
      const { first, second } = nextWindows()
      await repo.claim('research-budget', first)

      const results = await Promise.all(Array.from({ length: 8 }, () => repo.claim('research-budget', second)))

      expect(results.filter(Boolean)).toHaveLength(1)
    })
  })
}

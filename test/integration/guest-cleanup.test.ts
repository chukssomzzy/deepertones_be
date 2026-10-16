import { env } from 'cloudflare:workers'
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../../src/index'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000
const seenAgo = (days: number) => new Date(NOW - days * DAY)

describe('the daily guest cleanup (scheduled handler)', () => {
  it('deletes only guests with no device that have not been seen for over 90 days', async () => {
    const repo = new D1UsersRepository(createDb(env.DB))
    const salt = crypto.randomUUID()
    const seed = async (label: string, seenAt: Date) => {
      const id = crypto.randomUUID()
      await repo.createGuestForDevice({ user: { id, createdAt: seenAt }, device: { deviceHash: `${label}-${salt}`, platform: 'ios' }, profile: { id: crypto.randomUUID() } })
      await repo.touch(id, seenAt)
      return id
    }
    const oldUnlinked = await seed('old-unlinked', seenAgo(120))
    await repo.unlinkDevices(oldUnlinked)
    const oldLinked = await seed('old-linked', seenAgo(120))
    const recentUnlinked = await seed('recent-unlinked', seenAgo(10))
    await repo.unlinkDevices(recentUnlinked)
    const oldVerified = await seed('old-verified', seenAgo(120))
    await repo.promote(oldVerified, { kind: 'email', email: `cleanup-${salt}@example.com` as EmailAddress }, seenAgo(120))
    await repo.unlinkDevices(oldVerified)

    const ctx = createExecutionContext()
    await worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron: '17 3 * * *' }), env, ctx)
    await waitOnExecutionContext(ctx)

    expect(await repo.findById(oldUnlinked)).toBeNull()
    expect(await repo.findById(oldLinked)).not.toBeNull()
    expect(await repo.findById(recentUnlinked)).not.toBeNull()
    expect(await repo.findById(oldVerified)).not.toBeNull()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { ReminderFanOutService } from './reminders.fan-out.service'
import type { StartedProfile } from './reminders.types'

// 06:45 UTC on 2030-06-15: 07:45 in Lagos (UTC+1), 07:45 in London (UTC+1 in June), 02:45 in New York.
const SLOT = Date.UTC(2030, 5, 15, 6, 45)
const MIDNIGHT = Date.UTC(2030, 5, 15)
const at = (hour: number, minute = 0) => new Date(MIDNIGHT + (hour * 60 + minute) * 60 * 1000)

const row = (profileId: string, over: Partial<StartedProfile> = {}): StartedProfile => ({ profileId, enabled: true, morning: '07:00', evening: '21:00', timeZone: null, ...over })
/** A started profile with no settings row, as the left join answers it. */
const noRow = (profileId: string): StartedProfile => ({ profileId, enabled: null, morning: null, evening: null, timeZone: null })

const build = (started: StartedProfile[]) => {
  const jobs = new MemoryJobQueue()
  const reads: number[] = []
  const service = new ReminderFanOutService({
    profiles: { startedProfiles: async () => (reads.push(1), started) },
    jobs,
  })
  return { service, jobs, reads }
}
const queuedIds = (jobs: MemoryJobQueue) => jobs.enqueued.map(({ body }) => (body as { profileId: string }).profileId)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ReminderFanOutService.fanOut', () => {
  it('queues one reminder-profile message for each started profile with a time due in the slot, carrying the slot, after one read', async () => {
    const { service, jobs, reads } = build([row('due-1', { morning: '06:45' }), row('later', { morning: '07:30' }), row('due-2', { evening: '06:40' })])

    const queued = await service.fanOut(at(6, 45))

    expect(queued).toBe(2)
    expect(reads).toHaveLength(1)
    expect(jobs.enqueued).toEqual([
      { job: 'send-push', body: { kind: 'reminder-profile', profileId: 'due-1', slot: SLOT } },
      { job: 'send-push', body: { kind: 'reminder-profile', profileId: 'due-2', slot: SLOT } },
    ])
  })

  it('reads a time in the profile\'s own zone', async () => {
    const { service, jobs } = build([row('lagos', { timeZone: 'Africa/Lagos', morning: '07:45' }), row('utc', { morning: '07:45' })])

    await service.fanOut(at(6, 45))

    expect(queuedIds(jobs)).toEqual(['lagos'])
  })

  it('counts a profile with no settings row as 07:00 and 21:00 in UTC', async () => {
    const morning = build([noRow('nobody')])
    const evening = build([noRow('nobody')])
    const neither = build([noRow('nobody')])

    await morning.service.fanOut(at(7))
    await evening.service.fanOut(at(21))
    await neither.service.fanOut(at(6, 45))

    expect(queuedIds(morning.jobs)).toEqual(['nobody'])
    expect(queuedIds(evening.jobs)).toEqual(['nobody'])
    expect(queuedIds(neither.jobs)).toEqual([])
  })

  it('counts a profile with reminders off by the defaults too, in its stored zone, whatever times the row holds', async () => {
    const { service, jobs } = build([
      row('off-utc', { enabled: false, morning: '03:00', evening: '04:00' }),
      row('off-lagos', { enabled: false, timeZone: 'Africa/Lagos', morning: '07:00', evening: '08:00' }),
    ])

    // 07:00 UTC is 08:00 in Lagos: the default morning is due for the first and not for the second, whatever the times in the rows say.
    await service.fanOut(at(7))

    expect(queuedIds(jobs)).toEqual(['off-utc'])
  })

  it('skips a profile whose zone is not one, logging its id and nothing else, and queues the others', async () => {
    const { service, jobs } = build([row('bad', { timeZone: 'Not/AZone', morning: '06:45' }), row('good', { morning: '06:45' })])
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const queued = await service.fanOut(at(6, 45))

    expect(queued).toBe(1)
    expect(queuedIds(jobs)).toEqual(['good'])
    expect(logged).toHaveBeenCalledWith({ job: 'reminder-send', outcome: 'profile-skipped', profileId: 'bad' })
  })

  it('queues nothing, and makes no batch call, when no routine is Started or nothing is due', async () => {
    const none = build([])
    const nothingDue = build([row('later', { morning: '09:00' })])

    expect(await none.service.fanOut(at(6, 45))).toBe(0)
    expect(await nothingDue.service.fanOut(at(6, 45))).toBe(0)
    expect(none.jobs.enqueued).toEqual([])
    expect(nothingDue.jobs.enqueued).toEqual([])
  })

  it('throws when the queue refuses the messages', async () => {
    const { service, jobs } = build([row('due', { morning: '06:45' })])
    jobs.failNextWith(new Error('queue is down'))

    await expect(service.fanOut(at(6, 45))).rejects.toThrow('queue is down')
  })
})

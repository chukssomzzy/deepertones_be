import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContainer } from '../../src/container'
import { createDb } from '../../src/lib/db'
import { RoutineCheckInsService } from '../../src/modules/routines/routines.check-ins.service'
import { routineVersions } from '../../src/modules/routines/routines.table'
import { RoutineViewerService } from '../../src/modules/routines/routines.viewer.service'
import { profiles } from '../../src/modules/profiles/profiles.table'
import { users } from '../../src/modules/users/users.table'
import {
  fanOutIn,
  fireCron,
  deliver,
  namingProfile,
  newProfile,
  pushesIn,
  queueSinks,
  startedRoutinesWiped,
  workerEnv,
  LAGOS,
  DAY,
  SLOT,
  TODAY,
  TODAY_LOCAL,
  type Pushed,
  type Sent,
  type WorldProfile,
} from './reminders.fan-out.support'

// The 15-minute reminder job at scale (spec #233, PR 8a). Each due profile costs about 15 D1 calls, and Lagos at 07:00 is one spike, so the cron no longer does the profiles'
// work itself: it lists the started profiles with their reminder times once (one statement), keeps those with a time due in the slot, and queues one message for each, in
// batches; a queue consumer does what the cron's per-profile body did. A profile with no settings row, or reminders off, is counted by the defaults (07:00 and 21:00 in its
// stored zone, UTC with none), because the inbox lines of PR 8b are written for it at those times; the consumer still sends it no push.
//
// ASSUMED, and nothing else is: the queue is one the Worker already has (no queue is created for this), so every test below finds the cron's messages on whichever
// binding the cron sent them to and delivers them, unchanged, to that binding's own queue. The shape of a message is not pinned; a message names its profile (its id is
// somewhere in the body) and carries the cron's scheduled time, and the tests only ever hand the consumer what the cron queued. What a profile is sent is the same as ever.
const GUEST_CLEANUP_CRON = '17 3 * * *'
const SCAN_REAPER_CRON = '*/10 * * * *'
const BATCH_LIMIT = 100
const HOUR = 60 * 60 * 1000
/** 07:00 UTC, the defaults' morning; 21:00 UTC, their evening. */
const UTC_MORNING = TODAY + 7 * HOUR
const UTC_EVENING = TODAY + 21 * HOUR

afterEach(() => {
  vi.restoreAllMocks()
})

// The cron counts every started routine in the database, so each test starts from none, and then counts only its own.
beforeEach(async () => {
  await startedRoutinesWiped()
})

const quietly = () => vi.spyOn(console, 'error').mockImplementation(() => undefined)

type World = Record<string, WorldProfile>

/**
 * One of each kind of profile the job meets. At the slot (06:00 UTC), `lagosMorning` is due its 07:00 morning reminder and `utcBoth` its morning and its evening; `missed` is due
 * its morning one and a nudge for the three days it has not ticked off anything; the others are not sent a thing, for the reason in their name.
 */
const newWorld = async (): Promise<World> => ({
  lagosMorning: await newProfile({ zone: LAGOS }),
  utcBoth: await newProfile({ zone: null, morning: '06:00', evening: '06:00' }),
  missed: await newProfile({ zone: LAGOS, dayOne: -3, nudge: true }),
  notDueYet: await newProfile({ zone: LAGOS, morning: '07:30' }),
  noPhone: await newProfile({ zone: LAGOS, phone: false }),
  remindersOff: await newProfile({ zone: LAGOS, enabled: false }),
  noSettingsRow: await newProfile({ zone: LAGOS, noSettings: true }),
  notStarted: await newProfile({ zone: LAGOS, dayOne: null }),
})

/** The pushes a world was sent, by the name of the profile, in a fixed order, with the words the phone shows. */
const labelled = (world: World, pushes: Pushed[]) => {
  const names = new Map(Object.entries(world).map(([name, { profileId }]) => [profileId, name]))
  return pushes
    .filter(({ profileId }) => names.has(profileId))
    .map(({ profileId, ...rest }) => ({ profile: names.get(profileId)!, ...rest }))
    .sort((a, b) => `${a.profile}${a.kind}${a.time ?? ''}`.localeCompare(`${b.profile}${b.kind}${b.time ?? ''}`))
}

const WORDS = 'Cleanser, Moisturiser'
/** What the single job sent for `newWorld` at the slot (it is what the job sends today; the fan-out must send the same). */
const SENT_AT_SLOT = [
  { profile: 'lagosMorning', kind: 'routine-reminder', day: TODAY_LOCAL, time: 'morning', title: WORDS },
  { profile: 'missed', kind: 'missed-days-nudge', since: '2031-03-07' },
  { profile: 'missed', kind: 'routine-reminder', day: TODAY_LOCAL, time: 'morning', title: WORDS },
  { profile: 'utcBoth', kind: 'routine-reminder', day: TODAY_LOCAL, time: 'evening', title: WORDS },
  { profile: 'utcBoth', kind: 'routine-reminder', day: TODAY_LOCAL, time: 'morning', title: WORDS },
]

const without = (rows: Record<string, unknown>[]) => rows.map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)))

const startedCount = async () => (await env.DB.prepare('SELECT COUNT(DISTINCT profile_id) AS n FROM routine_versions WHERE started_on IS NOT NULL').first<{ n: number }>())!.n

/**
 * Started profiles with no settings row, made with a few plain inserts and not through the write paths a person's data takes, so a hundred of them are cheap. They are
 * what the cron reads: a profile, with a routine version that has a start.
 */
const startedDirectly = async (count: number): Promise<string[]> => {
  const db = createDb(env.DB)
  const ids = Array.from({ length: count }, () => crypto.randomUUID())
  const at = new Date(TODAY - 30 * DAY)
  for (let from = 0; from < ids.length; from += 25) {
    const inserts = ids.slice(from, from + 25).flatMap((profileId) => [
      db.insert(users).values({ id: `user-${profileId}`, createdAt: at, lastSeenAt: at }),
      db.insert(profiles).values({ id: profileId, userId: `user-${profileId}`, isDefault: true, createdAt: at }),
      db.insert(routineVersions).values({
        id: `version-${profileId}`,
        profileId,
        status: 'ready',
        createdAt: at,
        steps: [],
        tapers: [],
        startedOn: new Date(TODAY),
        rulesVersion: '1',
        hintsShown: false,
        verdictFingerprint: 'verdict-fp-1',
        reason: 'first',
      }),
    ])
    await db.batch(inserts as unknown as Parameters<typeof db.batch>[0])
  }
  return ids
}

/** The cron's messages, all of them, for a world of profiles started or not. */
const cronMessages = async (sinks = queueSinks(), over: Partial<CloudflareBindings> = {}, slot = SLOT) => {
  await fireCron(workerEnv(sinks, over), undefined, slot)
  return { sinks, queued: sinks.drain() }
}

describe('the 15-minute cron', () => {
  it('queues one message for each started profile with a reminder time due in the slot, whether or not it has reminders on or a phone, and none for the rest', async () => {
    const world = await newWorld()
    const twice = await newProfile({ versions: 2 })

    const { queued: all } = await cronMessages()
    const queued = fanOutIn(all)

    // At 06:00 UTC: 07:00 in Lagos is due for these (reminders off and no phone are the consumer's business); 07:30 is not, and nor is the defaults' 07:00 UTC for a profile with no row.
    const due = ['lagosMorning', 'utcBoth', 'missed', 'noPhone', 'remindersOff'].map((name) => world[name]!.profileId)
    for (const profileId of [...due, twice.profileId]) expect(namingProfile(queued, profileId), profileId).toHaveLength(1)
    for (const name of ['notDueYet', 'noSettingsRow', 'notStarted']) expect(namingProfile(queued, world[name]!.profileId), name).toEqual([])
    expect(queued).toHaveLength(due.length + 1)
  })

  it('carries the cron slot, and the profile, in each message', async () => {
    const profile = await newProfile()

    const { queued } = await cronMessages()

    expect(fanOutIn(queued).map(({ body }) => body)).toEqual([{ kind: 'reminder-profile', profileId: profile.profileId, slot: SLOT }])
  })

  it('counts a profile with no settings row, or with reminders off, by the defaults: 07:00 and 21:00 in its stored zone, UTC with none', async () => {
    const noRow = await newProfile({ noSettings: true })
    // Reminders off, with times of its own that are not used, and a zone of its own that is.
    const offInLagos = await newProfile({ enabled: false, zone: LAGOS, morning: '03:00', evening: '04:00' })
    const offNoZone = await newProfile({ enabled: false, zone: null, morning: '03:00', evening: '04:00' })
    const onInLagos = await newProfile({ zone: LAGOS })

    const morning = fanOutIn((await cronMessages(queueSinks(), {}, UTC_MORNING)).queued)
    expect(namingProfile(morning, noRow.profileId)).toHaveLength(1)
    expect(namingProfile(morning, offNoZone.profileId)).toHaveLength(1)
    expect(namingProfile(morning, offInLagos.profileId)).toEqual([])
    expect(namingProfile(morning, onInLagos.profileId)).toEqual([])

    const evening = fanOutIn((await cronMessages(queueSinks(), {}, UTC_EVENING)).queued)
    expect(namingProfile(evening, noRow.profileId)).toHaveLength(1)
    expect(namingProfile(evening, offNoZone.profileId)).toHaveLength(1)
    // 21:00 UTC is 22:00 in Lagos.
    expect(namingProfile(evening, offInLagos.profileId)).toEqual([])
    expect(namingProfile(evening, onInLagos.profileId)).toEqual([])
  })

  it('queues a profile once when both its times are due in the slot', async () => {
    const both = await newProfile({ zone: null, morning: '06:00', evening: '06:00' })

    const { queued } = await cronMessages()

    expect(namingProfile(fanOutIn(queued), both.profileId)).toHaveLength(1)
  })

  it('skips a profile whose zone is not one, logging its id, and queues the others', async () => {
    const bad = await newProfile({ zone: 'Not/AZone' })
    const good = await newProfile()
    const logged = quietly()

    const { queued } = await cronMessages()

    expect(namingProfile(fanOutIn(queued), bad.profileId)).toEqual([])
    expect(namingProfile(fanOutIn(queued), good.profileId)).toHaveLength(1)
    expect(logged).toHaveBeenCalledWith({ job: 'reminder-send', outcome: 'profile-skipped', profileId: bad.profileId })
  })

  it('reads the started profiles with one query and does nothing for the profiles itself', async () => {
    await newWorld()
    const calls: string[] = []
    const DB = new Proxy(env.DB, {
      get: (target, property) => {
        const value = Reflect.get(target, property)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          calls.push(String(property))
          return value.apply(target, args)
        }
      },
    })

    await cronMessages(queueSinks(), { DB })

    expect(calls).toEqual(['prepare'])
  })

  it('sends no push and claims no reminder itself, so Lagos at 07:00 is not one big run', async () => {
    const world = await newWorld()

    const { queued } = await cronMessages()

    expect(pushesIn(queued)).toEqual([])
    const ids = Object.values(world).map(({ profileId }) => profileId)
    const claims = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reminder_sends WHERE profile_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).first<{ n: number }>()
    expect(claims!.n).toBe(0)
  })

  it('sends the messages in batches of at most 100, a hundred in one and a hundred and one in two', async () => {
    // At 07:00 UTC every one of them, with no settings row, is due its morning by the defaults.
    const hundred = await startedDirectly(BATCH_LIMIT)
    const first = queueSinks()

    const { queued: firstSent } = await cronMessages(first, {}, UTC_MORNING)
    const firstRun = fanOutIn(firstSent)

    expect(first.batches.map(({ size }) => size)).toEqual([BATCH_LIMIT])
    expect(first.singles).toEqual([])
    expect(firstRun).toHaveLength(BATCH_LIMIT)

    const [one] = await startedDirectly(1)
    const second = queueSinks()

    const { queued: secondSent } = await cronMessages(second, {}, UTC_MORNING)
    const secondRun = fanOutIn(secondSent)

    expect(second.batches.map(({ size }) => size).sort((a, b) => b - a)).toEqual([BATCH_LIMIT, 1])
    expect(second.singles).toEqual([])
    // Every profile once, none dropped between batches.
    for (const profileId of [...hundred, one!]) expect(namingProfile(secondRun, profileId), profileId).toHaveLength(1)
    expect(secondRun).toHaveLength(BATCH_LIMIT + 1)
  }, 120_000)

  it('queues the due profiles only, and no batch at all when no started profile has a time due', async () => {
    await startedDirectly(3)
    const sinks = queueSinks()

    // 06:00 UTC: nothing is due by the defaults.
    const { queued } = await cronMessages(sinks)

    expect(queued).toEqual([])
    expect(sinks.batches).toEqual([])
    expect(await startedCount()).toBe(3)
  })

  it('queues nothing, and does not send an empty batch, when no routine is Started', async () => {
    await newProfile({ dayOne: null })
    const sinks = queueSinks()

    const { queued } = await cronMessages(sinks)

    expect(queued).toEqual([])
    expect(sinks.batches).toEqual([])
    expect(await startedCount()).toBe(0)
  })

  it('queues no profile on the daily and the 10 minute crons, which have nothing to do with reminders', async () => {
    const { profileId } = await newProfile()
    const sinks = queueSinks()
    quietly()

    await fireCron(workerEnv(sinks), GUEST_CLEANUP_CRON)
    await fireCron(workerEnv(sinks), SCAN_REAPER_CRON)

    expect(namingProfile(sinks.sent, profileId)).toEqual([])
  })

  it('fails the run when queueing fails, and logs it as { job, outcome: failed } with nothing in it that names a person', async () => {
    await newProfile()
    const logged = quietly()
    const sinks = queueSinks()
    sinks.state.failBatches = true

    await expect(fireCron(workerEnv(sinks))).rejects.toThrow('queue is down')

    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ job: 'reminder-send', outcome: 'failed' }))
    expect(logged.mock.calls.map((call) => JSON.stringify(call)).join('\n')).not.toContain('ExponentPushToken[abc]')
  })
})

describe('the consumer of a profile message', () => {
  /** The cron's messages for the profiles of the world, ready to deliver. */
  const queuedFor = async (world: World) => {
    const sinks = queueSinks()
    const { queued } = await cronMessages(sinks)
    const ids = Object.values(world).map(({ profileId }) => profileId)
    return { sinks, messages: fanOutIn(queued).filter(({ body }) => ids.some((id) => JSON.stringify(body).includes(id))) }
  }
  const messageOf = (messages: Sent[], profile: WorldProfile) => {
    const found = namingProfile(messages, profile.profileId)
    expect(found, profile.profileId).toHaveLength(1)
    return found[0]!
  }

  it('sends, for the slot the cron was scheduled for and not the moment it runs, the pushes the single job sent: same reminders, words, nudge and claims', async () => {
    // The single job, on a world of its own, is the "before"; the cron and the consumer, on another identical one, the "after".
    const before = await newWorld()
    const old = queueSinks()
    await buildContainer(workerEnv(old)).reminderSends.sendDue(new Date(SLOT))
    const sentBefore = labelled(before, pushesIn(old.drain()))

    const after = await newWorld()
    const { sinks, messages } = await queuedFor(after)
    const consumed = await deliver(workerEnv(sinks), messages)
    const sentAfter = labelled(after, pushesIn(sinks.drain()))

    expect(without(sentBefore)).toEqual(SENT_AT_SLOT)
    expect(without(sentAfter)).toEqual(SENT_AT_SLOT)
    expect(sentAfter).toEqual(sentBefore)
    expect(consumed.retried).toEqual([])
    expect(consumed.acked).toHaveLength(messages.length)
  })

  it('sends nothing for a profile with reminders off, no phone, no settings, a time not reached or a routine not Started, even when its message is delivered', async () => {
    const world = await newWorld()
    const { sinks, messages } = await queuedFor(world)
    // The cron queues only the profiles with a time due, so the consumer's own re-check of the rest is met with messages made by hand.
    const byHand = (profile: WorldProfile): Sent => ({ binding: 'PUSH_DELIVERY_QUEUE', body: { kind: 'reminder-profile', profileId: profile.profileId, slot: SLOT } })
    const extra = [world.notDueYet!, world.noSettingsRow!, world.notStarted!].map(byHand)

    const consumed = await deliver(workerEnv(sinks), [...messages, ...extra])

    const sent = labelled(world, pushesIn(sinks.drain()))
    for (const name of ['notDueYet', 'noPhone', 'remindersOff', 'noSettingsRow', 'notStarted']) expect(sent.filter(({ profile }) => profile === name), name).toEqual([])
    // Each of them was a message that was handled and finished, not one left to come back: the five the cron queued and the three made by hand.
    expect(messages).toHaveLength(5)
    expect(consumed.retried).toEqual([])
    expect(consumed.acked).toHaveLength(8)
  })

  it('sends nothing twice when a message is delivered again', async () => {
    const world = await newWorld()
    const { sinks, messages } = await queuedFor(world)
    await deliver(workerEnv(sinks), messages)
    const first = labelled(world, pushesIn(sinks.drain()))

    const again = await deliver(workerEnv(sinks), messages, { attempts: 2 })

    expect(first).toHaveLength(SENT_AT_SLOT.length)
    expect(pushesIn(sinks.drain())).toEqual([])
    expect(again.retried).toEqual([])
  })

  it('sends nothing twice even when the queue system has no record of the first delivery, because the reminder claims hold', async () => {
    const world = await newWorld()
    const { sinks, messages } = await queuedFor(world)
    await deliver(workerEnv(sinks), messages)
    expect(labelled(world, pushesIn(sinks.drain()))).toHaveLength(SENT_AT_SLOT.length)
    // What the dispatcher keeps to recognise a repeat (job_runs) is gone, as it is once it is purged or if the repeat is keyed differently: only reminder_sends is left to say it was sent.
    await env.DB.prepare('DELETE FROM job_runs').run()

    await deliver(workerEnv(sinks), messages, { attempts: 2 })

    expect(pushesIn(sinks.drain())).toEqual([])
  })

  it('sends nothing for a slot the single job already sent, as when a deploy lands between the two', async () => {
    const world = await newWorld()
    const { sinks, messages } = await queuedFor(world)
    await buildContainer(workerEnv(sinks)).reminderSends.sendDue(new Date(SLOT))
    expect(labelled(world, pushesIn(sinks.drain()))).toHaveLength(SENT_AT_SLOT.length)

    await deliver(workerEnv(sinks), messages)

    expect(pushesIn(sinks.drain())).toEqual([])
  })

  it('retries the message of a profile that fails, and the others in the batch are still sent and finished', async () => {
    const [first, bad, last] = [await newProfile(), await newProfile(), await newProfile()] as [WorldProfile, WorldProfile, WorldProfile]
    const { sinks, messages } = await queuedFor({ first, bad, last })
    const batch = [messageOf(messages, first), messageOf(messages, bad), messageOf(messages, last)]
    const ids = [first.profileId, bad.profileId, last.profileId]
    const quiet = quietly()
    const real = RoutineViewerService.prototype.reminderPlanFor
    const failing = vi.spyOn(RoutineViewerService.prototype, 'reminderPlanFor').mockImplementation(function (this: RoutineViewerService, profileId: string) {
      if (profileId === bad.profileId) throw new Error('the database is down for ExponentPushToken[abc]')
      return real.call(this, profileId)
    })

    const consumed = await deliver(workerEnv(sinks), batch, { ids })

    expect(consumed.retried).toEqual([bad.profileId])
    expect([...consumed.acked].sort()).toEqual([first.profileId, last.profileId].sort())
    expect(pushesIn(sinks.drain()).map(({ profileId }) => profileId).sort()).toEqual([first.profileId, last.profileId].sort())
    expect(quiet.mock.calls.map((call) => JSON.stringify(call)).join('\n')).not.toContain('ExponentPushToken[abc]')

    // The retry finds the profile well and sends its reminder: nothing was claimed by the try that failed.
    failing.mockRestore()
    const retry = await deliver(workerEnv(sinks), [messageOf(messages, bad)], { attempts: 2, ids: [bad.profileId] })

    expect(retry).toEqual({ acked: [bad.profileId], retried: [] })
    expect(pushesIn(sinks.drain())).toEqual([expect.objectContaining({ profileId: bad.profileId, kind: 'routine-reminder', day: TODAY_LOCAL, time: 'morning' })])
  })

  it('keeps the claim of a push sent before a later failure, so the retry sends what is left and nothing twice', async () => {
    const world = await newWorld()
    const { sinks, messages } = await queuedFor(world)
    const missed = messageOf(messages, world.missed!)
    quietly()
    const real = RoutineCheckInsService.prototype.missedStreak
    // The morning reminder is claimed and queued first; reading the missed days comes after it, and fails on the first delivery only.
    vi.spyOn(RoutineCheckInsService.prototype, 'missedStreak').mockRejectedValueOnce(new Error('the database is down for ExponentPushToken[abc]')).mockImplementation(function (this: RoutineCheckInsService, ...args) {
      return real.apply(this, args)
    })

    const first = await deliver(workerEnv(sinks), [missed], { ids: ['missed'] })

    expect(first).toEqual({ acked: [], retried: ['missed'] })
    expect(pushesIn(sinks.drain())).toEqual([expect.objectContaining({ profileId: world.missed!.profileId, kind: 'routine-reminder', time: 'morning' })])

    const second = await deliver(workerEnv(sinks), [missed], { attempts: 2, ids: ['missed'] })

    expect(second).toEqual({ acked: ['missed'], retried: [] })
    expect(pushesIn(sinks.drain())).toEqual([expect.objectContaining({ profileId: world.missed!.profileId, kind: 'missed-days-nudge', since: '2031-03-07' })])
  })
})

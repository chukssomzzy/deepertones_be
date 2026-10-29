import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContainer } from '../../src/container'
import { createDb } from '../../src/lib/db'
import { InboxService } from '../../src/modules/inbox/inbox.service'
import { D1StepPausesRepository } from '../../src/modules/skin-care/skin-care.pauses.repository'
import {
  deliver,
  fanOutIn,
  fireCron,
  newProfile,
  pushMessagesIn,
  pushesIn,
  queueSinks,
  startedRoutinesWiped,
  workerEnv,
  DAY,
  LAGOS,
  SLOT,
  TODAY,
  TODAY_LOCAL,
  type Sent,
  type Sinks,
  type WorldProfile,
} from './reminders.fan-out.support'

// The inbox rows of the 15-minute job and the pause check-in push (spec #233, PR 8b) through the Worker: the cron queues the profile messages, the queue consumer works a
// profile's slot, and what a person ends up with is observed as the app gets it: the inbox rows (read through InboxService, the read Today uses) and the pushes a phone is handed
// (the queue's push messages delivered through the Worker's own queue handler, with only Expo stubbed at fetch). The world is the fan-out's: guests with a profile, a routine Started
// through the repository, reminder settings and a push token, each by the write path the app uses. The cron slot is frozen (06:00 UTC on a day in March 2031, 07:00 in Lagos), and the
// consumer runs later, at the real time, so a row is only found if the consumer works from the slot on the message.
//
// ASSUMED, and nothing else is: the cron and the consumer need no new queue; a row's key is as the issue names it; the pause check-in push is a push message of kind 'pause-check-in'.
// The one pause state this file puts in place by hand is a check-in with no step (the 'nothing to pause' pause) with its check day on the frozen day: a check day on a frozen day in
// 2031 cannot be made through the log route, which runs on the real clock (skin-care.routes.test.ts puts a pause on an earlier day the same way).

const HOUR = 60 * 60 * 1000
/** 11:00 UTC on the day: 07:00 in New York (EDT since 9 March 2031). */
const NEW_YORK_MORNING = TODAY + 11 * HOUR
/** 01:00 UTC on the next day: 21:00 on the day in New York, which is already the next day in UTC. */
const NEW_YORK_EVENING = TODAY + DAY + 1 * HOUR
const NEW_YORK = 'America/New_York'
const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send'
const MORNING_WORDS = { title: 'Cleanser, Moisturiser', body: 'Time for your morning routine' }

const db = createDb(env.DB)
const pausesRepository = new D1StepPausesRepository(db)

beforeEach(async () => {
  await startedRoutinesWiped()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

type ExpoMessage = { to: string; title: string; body: string; data: Record<string, unknown> }
let expoSends: ExpoMessage[]
const stubExpo = () => {
  expoSends = []
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url) !== EXPO_SEND_URL) throw new Error(`unexpected outbound request to ${String(url)}`)
    const messages = JSON.parse(init!.body as string) as ExpoMessage[]
    expoSends.push(...messages)
    return Response.json({ data: messages.map(() => ({ status: 'ok', id: `ticket-${crypto.randomUUID()}` })) })
  })
}
const tokenOf = ({ userId }: WorldProfile) => `ExponentPushToken[${userId}]`
const handedTo = (profile: WorldProfile) => expoSends.filter(({ to }) => to === tokenOf(profile))

const rowsOf = async (profile: WorldProfile) => (await buildContainer(workerEnv(queueSinks())).inbox.summaryFor(profile.profileId)).latest
const keysOf = async (profile: WorldProfile) =>
  (await env.DB.prepare('SELECT key FROM inbox_items WHERE profile_id = ? ORDER BY key').bind(profile.profileId).all<{ key: string }>()).results.map(({ key }) => key)
const claimsOf = async (profile: WorldProfile) =>
  (await env.DB.prepare('SELECT kind FROM reminder_sends WHERE profile_id = ? ORDER BY kind').bind(profile.profileId).all<{ kind: string }>()).results.map(({ kind }) => kind)

/** The cron for `slot`: the profile messages it queued, for these profiles. */
const cronFor = async (profiles: WorldProfile[], slot: number, sinks: Sinks = queueSinks()) => {
  await fireCron(workerEnv(sinks), undefined, slot)
  const ids = profiles.map(({ profileId }) => profileId)
  return { sinks, messages: fanOutIn(sinks.drain()).filter(({ body }) => ids.some((id) => JSON.stringify(body).includes(id))) }
}

/** Delivers the profile messages to the consumer, and then the pushes it queued (with Expo stubbed), the way the queues would. Answers what the consumer finished and retried. */
const consume = async (sinks: Sinks, messages: Sent[], options: { attempts?: number } = {}) => {
  const consumed = await deliver(workerEnv(sinks), messages, options)
  const pushes = pushMessagesIn(sinks.drain())
  if (pushes.length > 0) {
    stubExpo()
    await deliver(workerEnv(sinks), pushes)
  } else {
    expoSends = []
  }
  return { consumed, pushes }
}

describe('the inbox rows the consumer writes', () => {
  it('writes a profile\'s reminder row whether it has reminders on, off or no phone, and sends a push only to the one with reminders on and a phone', async () => {
    const on = await newProfile({ zone: LAGOS })
    const off = await newProfile({ zone: LAGOS, enabled: false, morning: '03:00', evening: '04:00' })
    const noPhone = await newProfile({ zone: LAGOS, phone: false })
    const { sinks, messages } = await cronFor([on, off, noPhone], SLOT)

    const { pushes } = await consume(sinks, messages)

    for (const profile of [on, off, noPhone]) expect(await keysOf(profile), profile.profileId).toEqual([`reminder:${TODAY_LOCAL}:morning`])
    for (const profile of [on, off, noPhone]) {
      expect(await rowsOf(profile)).toEqual([expect.objectContaining({ kind: 'reminder', day: TODAY_LOCAL, ...MORNING_WORDS, link: '/routine', read: false })])
    }
    expect(pushesIn(pushes).map(({ profileId }) => profileId)).toEqual([on.profileId])
    expect(handedTo(on)).toHaveLength(1)
    expect(handedTo(off)).toEqual([])
    expect(handedTo(noPhone)).toEqual([])
    // Only the push is claimed.
    expect(await claimsOf(on)).toEqual(['morning'])
    expect(await claimsOf(off)).toEqual([])
    expect(await claimsOf(noPhone)).toEqual([])
  })

  it('counts a profile with no settings row by the defaults in UTC: its row comes at 07:00 UTC and not at 06:00', async () => {
    const noRow = await newProfile({ noSettings: true })

    const six = await cronFor([noRow], SLOT)
    await consume(six.sinks, six.messages)
    expect(await keysOf(noRow)).toEqual([])

    const seven = await cronFor([noRow], TODAY + 7 * HOUR)
    await consume(seven.sinks, seven.messages)
    expect(await keysOf(noRow)).toEqual([`reminder:${TODAY_LOCAL}:morning`])
    expect(handedTo(noRow)).toEqual([])
  })

  it('writes a New York profile\'s rows on its own local day: the morning at 11:00 UTC, and the evening, which is already the next day in UTC, for the day before', async () => {
    const tolu = await newProfile({ zone: NEW_YORK, enabled: false })

    const morning = await cronFor([tolu], NEW_YORK_MORNING)
    await consume(morning.sinks, morning.messages)
    const evening = await cronFor([tolu], NEW_YORK_EVENING)
    await consume(evening.sinks, evening.messages)

    expect(await keysOf(tolu)).toEqual([`reminder:${TODAY_LOCAL}:evening`, `reminder:${TODAY_LOCAL}:morning`])
    expect((await rowsOf(tolu)).map(({ day }) => day)).toEqual([TODAY_LOCAL, TODAY_LOCAL])
  })

  it('writes the rows of a slot once: a message delivered again, even when the queue has no record of the first delivery, makes no second row and no second push', async () => {
    const on = await newProfile({ zone: LAGOS })
    const off = await newProfile({ zone: LAGOS, enabled: false })
    const { sinks, messages } = await cronFor([on, off], SLOT)
    await consume(sinks, messages)
    const first = [...(await rowsOf(on)), ...(await rowsOf(off))].map(({ id }) => id).sort()
    await env.DB.prepare('DELETE FROM job_runs').run()

    const again = await consume(sinks, messages, { attempts: 2 })

    expect(first).toHaveLength(2)
    expect([...(await rowsOf(on)), ...(await rowsOf(off))].map(({ id }) => id).sort()).toEqual(first)
    expect(again.pushes).toEqual([])
    expect(again.consumed.retried).toEqual([])
  })

  it('writes nothing for a profile whose routine is not Started', async () => {
    const notStarted = await newProfile({ zone: LAGOS, dayOne: null })
    const sinks = queueSinks()

    await cronFor([notStarted], SLOT, sinks)
    // The cron queues nothing for it, and a message made by hand is met with nothing.
    const byHand: Sent = { binding: 'PUSH_DELIVERY_QUEUE', body: { kind: 'reminder-profile', profileId: notStarted.profileId, slot: SLOT } }
    await consume(sinks, [byHand])

    expect(await keysOf(notStarted)).toEqual([])
  })
})

describe('the push that is the delivery of a row', () => {
  it('hands the phone the reminder with the id of its inbox row, and the row\'s words are the push\'s', async () => {
    const on = await newProfile({ zone: LAGOS })
    const { sinks, messages } = await cronFor([on], SLOT)

    await consume(sinks, messages)

    const [row] = await rowsOf(on)
    expect(handedTo(on)).toHaveLength(1)
    expect(handedTo(on)[0]).toMatchObject({ title: row!.title, body: row!.body, data: { kind: 'routine-reminder', url: row!.link, profileId: on.profileId, day: TODAY_LOCAL, time: 'morning', inboxId: row!.id } })
  })

  it('still sends the push, and does not retry the message, when the inbox row cannot be written', async () => {
    const on = await newProfile({ zone: LAGOS })
    const { sinks, messages } = await cronFor([on], SLOT)
    vi.spyOn(InboxService.prototype, 'write').mockRejectedValue(new Error('the database is down for ExponentPushToken[abc]'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { consumed } = await consume(sinks, messages)

    expect(consumed.retried).toEqual([])
    expect(handedTo(on)).toHaveLength(1)
    expect(handedTo(on)[0]!.data).not.toHaveProperty('inboxId')
    expect(await claimsOf(on)).toEqual(['morning'])
    expect(await keysOf(on)).toEqual([])
    expect(JSON.stringify(logged.mock.calls)).toContain(on.profileId)
    expect(JSON.stringify(logged.mock.calls)).not.toContain('ExponentPushToken[abc]')
  })
})

describe('the pause check-in push', () => {
  /** A check-in with no step, as the 'nothing to pause' outcome leaves it, due on the frozen day. */
  const pauseDue = async (profile: WorldProfile, checkDay = TODAY_LOCAL) => {
    const id = crypto.randomUUID()
    await pausesRepository.insert({
      id,
      profileId: profile.profileId,
      step: null,
      productKey: '',
      productId: null,
      productRef: { kind: 'none' },
      ingredientGroup: null,
      state: 'paused',
      pausedOn: '2031-03-07',
      checkDay,
      sameCount: 0,
      sourceLogId: null,
      ladderCode: null,
      ladderStartedOn: null,
      versionId: null,
      createdAt: new Date(TODAY - 3 * DAY),
    })
    return id
  }
  const pauseKeys = async (profile: WorldProfile) => (await keysOf(profile)).filter((key) => key.startsWith('check-in-due:'))
  const pausePushes = (pushes: Sent[]) => pushesIn(pushes).filter(({ kind }) => kind === 'pause-check-in')

  it('hands a phone one push at the morning time for a check-in that is due, with the id of its check-in-due row, claimed as pause-check:<pauseId>:<checkDay>', async () => {
    const on = await newProfile({ zone: LAGOS })
    const pauseId = await pauseDue(on)
    const { sinks, messages } = await cronFor([on], SLOT)

    const { pushes } = await consume(sinks, messages)

    expect(pausePushes(pushes)).toHaveLength(1)
    expect(await pauseKeys(on)).toEqual([`check-in-due:${pauseId}:${TODAY_LOCAL}`])
    expect(await claimsOf(on)).toEqual(['morning', `pause-check:${pauseId}:${TODAY_LOCAL}`])
    const row = (await rowsOf(on)).find(({ kind }) => kind === 'check-in-due')!
    expect(row).toMatchObject({ day: TODAY_LOCAL, read: false })
    const handed = handedTo(on).find(({ data }) => data.kind === 'pause-check-in')!
    expect(handed.data).toMatchObject({ kind: 'pause-check-in', profileId: on.profileId, url: row.link, inboxId: row.id })
  })

  it('goes once per check day: the next morning, with the check-in unanswered, hands the phone nothing more and writes no second row', async () => {
    const on = await newProfile({ zone: LAGOS })
    await pauseDue(on)
    const today = await cronFor([on], SLOT)
    await consume(today.sinks, today.messages)

    const tomorrow = await cronFor([on], SLOT + DAY)
    const { pushes } = await consume(tomorrow.sinks, tomorrow.messages)

    expect(pausePushes(pushes)).toEqual([])
    expect(await pauseKeys(on)).toHaveLength(1)
    expect(handedTo(on).filter(({ data }) => data.kind === 'pause-check-in')).toEqual([])
  })

  it('writes the row, and sends no push and claims nothing, for a profile with reminders off', async () => {
    const off = await newProfile({ zone: LAGOS, enabled: false })
    const pauseId = await pauseDue(off)
    const { sinks, messages } = await cronFor([off], SLOT)

    const { pushes } = await consume(sinks, messages)

    expect(await pauseKeys(off)).toEqual([`check-in-due:${pauseId}:${TODAY_LOCAL}`])
    expect(pushes).toEqual([])
    expect(await claimsOf(off)).toEqual([])
  })

  it('is not due before its check day: a check day tomorrow writes no row and sends no push', async () => {
    const on = await newProfile({ zone: LAGOS })
    await pauseDue(on, '2031-03-11')
    const { sinks, messages } = await cronFor([on], SLOT)

    const { pushes } = await consume(sinks, messages)

    expect(await pauseKeys(on)).toEqual([])
    expect(pausePushes(pushes)).toEqual([])
  })

  it('is not sent at the evening time', async () => {
    const on = await newProfile({ zone: LAGOS })
    await pauseDue(on)
    // 21:00 in Lagos is 20:00 UTC.
    const { sinks, messages } = await cronFor([on], TODAY + 20 * HOUR)

    const { pushes } = await consume(sinks, messages)

    expect(pausePushes(pushes)).toEqual([])
    expect(await pauseKeys(on)).toEqual([])
  })
})

import { env } from 'cloudflare:workers'
import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, waitOnExecutionContext } from 'cloudflare:test'
import worker from '../../src/index'
import { queueNames } from '../../src/jobs/job'
import { createDb } from '../../src/lib/db'
import { D1PushTokensRepository } from '../../src/modules/notifications/notifications.repository'
import { D1RecommendationsRepository } from '../../src/modules/recommendations/recommendations.repository'
import { D1RemindersRepository } from '../../src/modules/reminders/reminders.repository'
import { D1RoutinesRepository, type RoutineVersionRow } from '../../src/modules/routines/routines.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

// Shared by the reminder fan-out specs (the cron that queues one message per started profile, and the consumer that does a profile's reminder work).
// Everything here goes through the repositories' own write paths, as the app does: a guest with a profile, a routine version that is ready and then Started,
// the reminder settings and a push token. Nothing is written to a table by hand except the wipe of the started routines between tests (see `startedRoutinesWiped`).

export const REMINDERS_CRON = '*/15 * * * *'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/**
 * The one anchor of the file's dates: midnight UTC of the calendar day the reminders in these specs are due on. SLOT is the instant the 15-minute cron was
 * SCHEDULED for, 06:00 UTC, which is 07:00 in Lagos (UTC+1, no daylight saving) and 06:00 in UTC. The consumer runs later than this (it runs now), so a
 * reminder is only found due if the consumer works from the scheduled time that rode on the message, not from its own clock.
 */
export const TODAY = Date.UTC(2031, 2, 10)
export const SLOT = TODAY + 6 * HOUR
export const TODAY_LOCAL = '2031-03-10'
export const LAGOS = 'Africa/Lagos'

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const routines = new D1RoutinesRepository(db)
const reminders = new D1RemindersRepository(db)
const pushTokens = new D1PushTokensRepository(db)
const shopping = new D1RecommendationsRepository(db)

// --- the world ---

export type WorldProfile = {
  userId: string
  profileId: string
}

type ProfileOptions = {
  /** A zone name; null leaves it unset (the job then reads UTC). */
  zone?: string | null
  morning?: string
  evening?: string
  /** Reminders switched on. A profile with them off still has a row. */
  enabled?: boolean
  /** A phone registered for the profile. */
  phone?: boolean
  /** Day 1 of the routine as an offset in days from TODAY (0 is today); null means the routine was never Started. */
  dayOne?: number | null
  /** How many ready versions the profile has; a rebuild carries the start forward, so each of them is Started. */
  versions?: number
  /** The missed-days nudge switch. */
  nudge?: boolean
  /** No settings row at all, as for a profile that never opened the reminders screen. */
  noSettings?: boolean
}

const routineRow = (profileId: string, createdAt: Date): RoutineVersionRow => ({
  id: crypto.randomUUID(),
  profileId,
  status: 'ready',
  createdAt,
  steps: [
    { step: 'cleanse', product: { kind: 'none' }, frequency: 'am-pm', reason: 'Use what you have for now.', grounding: [], gotIt: false, fixedFrom: null, changedOn: null },
    { step: 'moisturise', product: { kind: 'none' }, frequency: 'am-pm', reason: 'Use what you have for now.', grounding: [], gotIt: false, fixedFrom: null, changedOn: null },
  ],
  tapers: [],
  expectation: 'Give it 8 to 12 weeks before judging.',
  cautions: [],
  goal: 'fade-dark-marks',
  shelfCounts: { keep: 1, reduce: 0, drop: 0, stop: 0 },
  notInRoutine: [],
  readyAt: createdAt,
  startedOn: null,
  servedAt: null,
  model: 'claude-sonnet-5-5',
  promptHash: 'prompt-hash-1',
  catalogVersion: 7,
  rulesVersion: '1',
  hintsShown: false,
  verdictFingerprint: 'verdict-fp-1',
  routineFingerprint: 'routine-fp-1',
  source: 'writer',
  reason: 'first',
  writerRetryDueAt: null,
  writerCalls: 1,
})

/** A guest with its default profile, a routine (Started on the day asked for, or never), reminder settings and a phone, each through the write path the app uses. */
export const newProfile = async (options: ProfileOptions = {}): Promise<WorldProfile> => {
  const { zone = LAGOS, morning = '07:00', evening = '21:00', enabled = true, phone = true, dayOne = 0, versions = 1, nudge = false, noSettings = false } = options
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  const created = new Date(TODAY - 30 * DAY)
  await users.createGuestForDevice({ user: { id: userId, createdAt: created }, device: { deviceHash: `fan-out-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  // The routine view the job reads wants the country the person shops in.
  await shopping.append({ id: crypto.randomUUID(), profileId, country: 'NG', budgetBand: 'mid', createdAt: created })
  for (let i = 0; i < versions; i++) await routines.append(routineRow(profileId, new Date(created.getTime() + i * HOUR)))
  if (dayOne !== null) await routines.markStarted(profileId, new Date(TODAY + dayOne * DAY))
  if (!noSettings) await reminders.upsert(profileId, { enabled, morning, evening, timeZone: zone, missedDaysNudge: nudge, stepDownAlerts: false }, created)
  if (phone) {
    const deviceHash = `fan-out-device-${userId}`
    await pushTokens.upsert({ deviceHash, token: `ExponentPushToken[${userId}]`, platform: 'ios', userId, profileId, createdAt: created, updatedAt: created })
  }
  return { userId, profileId }
}

/**
 * A profile with a routine that is Started, which is all the cron looks for. The reminder settings are the ones a person who never touched reminders has
 * (none), so this is the cheap way to make many.
 */
export const startedProfile = (): Promise<WorldProfile> => newProfile({ noSettings: true, phone: false })

/**
 * Takes every Started routine out of the database, so a test that counts what the cron queued counts only its own world. This is the spec file's own cleanup
 * of its own rows (the database is shared by every test in a file); no product path deletes a routine version.
 */
export const startedRoutinesWiped = async (): Promise<void> => {
  await env.DB.prepare('DELETE FROM routine_versions').run()
}

// --- the queues ---

export type Sent = { binding: string; body: unknown }

/**
 * A recorder for every queue binding the Worker has. `send` and `sendBatch` both land in `sent` (a batch as one entry per message, in order), and each
 * `sendBatch` call is also written to `batches` with its size, so a test can tell one batch of 101 from a batch of 100 and one of 1. `failBatches` makes
 * `sendBatch` reject, as a queue that is down does.
 */
export const queueSinks = () => {
  const sent: Sent[] = []
  const batches: { binding: string; size: number }[] = []
  const singles: string[] = []
  const state = { failBatches: false }
  const bindings = Object.keys(env).filter((key) => key.endsWith('_QUEUE'))
  const sinks = Object.fromEntries(
    bindings.map((binding) => [
      binding,
      {
        send: async (body: unknown) => {
          singles.push(binding)
          sent.push({ binding, body })
        },
        sendBatch: async (requests: Iterable<{ body: unknown }>) => {
          if (state.failBatches) throw new Error('queue is down for ExponentPushToken[abc]')
          const list = [...requests]
          batches.push({ binding, size: list.length })
          for (const request of list) sent.push({ binding, body: request.body })
        },
      } as unknown as Queue,
    ]),
  )
  return {
    sinks,
    sent,
    batches,
    singles,
    state,
    /** Hands over what was recorded and forgets it. */
    drain: (): Sent[] => sent.splice(0, sent.length),
  }
}

export type Sinks = ReturnType<typeof queueSinks>

/**
 * The queue's own name for a binding, by the rule wrangler.jsonc states: `X_Y_QUEUE` is the `x-y` queue of the environment (queueNames in src/jobs/job.ts).
 * A message a Worker puts on a binding is delivered to this queue, so replaying it here is what Cloudflare does.
 */
export const queueOf = (binding: string): string => queueNames(binding.replace(/_QUEUE$/, '').toLowerCase().replaceAll('_', '-'), env.ENVIRONMENT).main

// --- the push messages ---

const PUSH_KINDS = ['routine-reminder', 'step-down-alert', 'missed-days-nudge', 'pause-check-in']

/** The body of a message, whether it was written bare or inside a `{ job, body }` envelope (a shared queue's). */
const unwrapped = (message: unknown): Record<string, unknown> => {
  const candidate = message as { job?: unknown; body?: unknown }
  if (typeof candidate === 'object' && candidate !== null && 'job' in candidate && 'body' in candidate && Object.keys(candidate).length === 2) return candidate.body as Record<string, unknown>
  return message as Record<string, unknown>
}

export type Pushed = { profileId: string; kind: string; day?: string; time?: string; since?: string; title?: string }

/** The reminder pushes among what was sent: their kind and what the phone is told, whichever queue binding carries them. */
export const pushesIn = (sent: Sent[]): Pushed[] =>
  sent
    .map(({ body }) => unwrapped(body))
    .filter((body) => PUSH_KINDS.includes(body.kind as string))
    .map(({ kind, profileId, day, time, since, title }) => ({ kind, profileId, day, time, since, title }) as Pushed)

/** The push messages among what was sent, as they were queued (to be delivered to the queue they went to); the profile messages the cron fans out are not among them. */
export const pushMessagesIn = (sent: Sent[]): Sent[] => sent.filter(({ body }) => PUSH_KINDS.includes(unwrapped(body).kind as string))

/** What was sent that is not a push: the profile messages the cron fans out. */
export const fanOutIn = (sent: Sent[]): Sent[] => sent.filter(({ body }) => !PUSH_KINDS.includes(unwrapped(body).kind as string))

/** The messages that name the profile. A message names a profile if its id is anywhere in it; the shape of the body is the implementation's. */
export const namingProfile = (sent: Sent[], profileId: string): Sent[] => sent.filter(({ body }) => JSON.stringify(body).includes(profileId))

// --- running the Worker ---

export const workerEnv = (sinks: Sinks, over: Partial<CloudflareBindings> = {}) => ({ ...env, ...sinks.sinks, ...over }) as typeof env

/** Fires the 15-minute cron for the slot, the way Cloudflare does. */
export const fireCron = async (e: typeof env, cron = REMINDERS_CRON, scheduledTime = SLOT) => {
  const ctx = createExecutionContext()
  await worker.scheduled!(createScheduledController({ scheduledTime, cron }), e, ctx)
  await waitOnExecutionContext(ctx)
}

/**
 * Delivers messages to the queue they were sent to, the way Cloudflare does, in one batch, and answers which were acked and which retried. A message's id is
 * its position in the list unless `ids` names it.
 */
export const deliver = async (e: typeof env, messages: Sent[], { attempts = 1, ids }: { attempts?: number; ids?: string[] } = {}) => {
  const queues = [...new Set(messages.map(({ binding }) => binding))]
  const acked: string[] = []
  const retried: string[] = []
  for (const binding of queues) {
    const mine = messages.map((message, at) => ({ message, id: ids?.[at] ?? String(at) })).filter(({ message }) => message.binding === binding)
    const batch = createMessageBatch(
      queueOf(binding),
      mine.map(({ message, id }) => ({ id, timestamp: new Date(), attempts, body: message.body })),
    )
    const ctx = createExecutionContext()
    await worker.queue!(batch, e, ctx)
    const result = await getQueueResult(batch, ctx)
    acked.push(...result.explicitAcks)
    retried.push(...result.retryMessages.map((m) => m.msgId))
  }
  return { acked, retried }
}

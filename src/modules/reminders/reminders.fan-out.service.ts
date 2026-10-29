import type { JobQueue } from '../../providers/job-queue/job-queue.provider'
import { sendPushSpec } from '../notifications/notifications.job-specs'
import { DEFAULT_TIMES, dueReminders, type ReminderClock, type SlotReadings } from './reminders.slot'
import type { StartedProfile } from './reminders.types'

export type ReminderFanOutServiceDeps = {
  /** Every profile with a Started routine and its reminder settings (RoutineService.startedProfiles: reminders may not import routines, so this is a narrow type). */
  profiles: { startedProfiles(): Promise<StartedProfile[]> }
  jobs: JobQueue
}

/**
 * The 15-minute reminder cron's whole job (spec #233, PR 8a): lists the profiles with a Started routine and their reminder times in one statement, keeps those with a time due
 * in the slot, and queues one `reminder-profile` message for each, so the work of each profile (about 15 D1 calls) is done by the queue consumer, in parallel and with retries,
 * and not by one Worker invocation. Most profiles have nothing due in a given quarter hour, so this keeps the queue, and the consumer's D1 writes, to the few that do. It reads
 * no request context, so it needs no actor.
 */
export class ReminderFanOutService {
  private readonly profiles: ReminderFanOutServiceDeps['profiles']
  private readonly jobs: JobQueue

  constructor(deps: ReminderFanOutServiceDeps) {
    this.profiles = deps.profiles
    this.jobs = deps.jobs
  }

  /**
   * Queues a message for each started profile with a time due in the quarter hour up to `slot`, carrying `slot`: the time the cron was scheduled for, which is what the consumer
   * works from (it runs later, and may be retried later still). "Due" is `dueReminders`, the function the consumer uses too. A profile with no settings row, or with reminders
   * off, counts as the defaults (07:00 and 21:00, in its stored zone, UTC with none), because the inbox lines of a profile without reminders are written at those times; the
   * consumer still sends it no push. The consumer checks everything again from the row it reads then. A profile whose zone is not one is logged by id and skipped. One read, no
   * push and no claim. Answers how many profiles were queued; a queue that refuses them throws, so the run fails.
   */
  async fanOut(slot: Date): Promise<number> {
    const readings: SlotReadings = new Map()
    const due: string[] = []
    for (const profile of await this.profiles.startedProfiles()) {
      try {
        if (dueReminders(ReminderFanOutService.clockOf(profile), slot, readings).length > 0) due.push(profile.profileId)
      } catch (error) {
        // A zone Intl does not know is the profile's stored data; the id is all the log says.
        if (!(error instanceof RangeError)) throw error
        console.error({ job: 'reminder-send', outcome: 'profile-skipped', profileId: profile.profileId })
      }
    }
    await this.jobs.enqueueBatch(
      sendPushSpec,
      due.map((profileId) => ({ kind: 'reminder-profile' as const, profileId, slot: slot.getTime() })),
    )
    return due.length
  }

  private static clockOf({ enabled, morning, evening, timeZone }: StartedProfile): ReminderClock {
    return enabled === true && morning !== null && evening !== null ? { morning, evening, timeZone } : { ...DEFAULT_TIMES, timeZone }
  }
}

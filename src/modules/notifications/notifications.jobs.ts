import type { Container } from '../../container'
import { defineJob } from '../../jobs/job'
import { checkPushReceiptsSpec, sendPushSpec } from './notifications.job-specs'

// Dead-lettered messages are logged without ids: a lost notification needs no repair, and a log carries no one's account.
export const sendPush = defineJob<typeof sendPushSpec.schema, Container>(sendPushSpec, {
  // The reminder cron's profile message is not a push: it is the profile's reminder work, which may queue pushes of its own. It throws on a failure, so the message is retried.
  handle: async (body, services) => {
    if (body.kind === 'reminder-profile') await services.reminderSends.sendForProfile(body.profileId, new Date(body.slot))
    else await services.notifications.deliver(body)
  },
  onDeadLetter: async () => {
    console.error({ job: sendPushSpec.name, outcome: 'dead-lettered' })
  },
})

export const checkPushReceipts = defineJob<typeof checkPushReceiptsSpec.schema, Container>(checkPushReceiptsSpec, {
  handle: (body, services) => services.notifications.checkReceipts(body),
  onDeadLetter: async () => {
    console.error({ job: checkPushReceiptsSpec.name, outcome: 'dead-lettered' })
  },
})

import type { Container } from '../../container'
import { defineJob } from '../../jobs/job'
import { checkPushReceiptsSpec, sendPushSpec } from './notifications.job-specs'

// Dead-lettered messages are logged without ids: a lost notification needs no repair, and a log carries no one's account.
export const sendPush = defineJob<typeof sendPushSpec.schema, Container>(sendPushSpec, {
  handle: (body, services) => services.notifications.deliver(body),
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

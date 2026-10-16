import { app } from './app'
import { createQueueHandler } from './jobs/dispatcher'
import { jobs } from './jobs/registry'
import { createScheduledRouter } from './jobs/scheduled'

export { app, type AppType } from './app'

// The Durable Object class must be a named export of the Worker's main module, next to the default export.
export { ScanStream } from './realtime/scan-stream'

export default {
  fetch: app.fetch,
  queue: createQueueHandler(jobs),
  scheduled: createScheduledRouter(),
} satisfies ExportedHandler<CloudflareBindings>

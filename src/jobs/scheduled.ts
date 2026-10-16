import { buildContainer } from '../container'
import { createScheduledHandler as createGuestCleanup } from './dispatcher'
import { describeError } from './safe-error'

// These two strings are wrangler.jsonc's `triggers.crons`, in the top level and both env blocks; scripts/wrangler-config.test.ts
// pins them there. A cron the Worker is given that is not one of these runs nothing.
export const GUEST_CLEANUP_CRON = '17 3 * * *'
export const SCAN_REAPER_CRON = '*/10 * * * *'

type ScheduledHandler = (controller: ScheduledController, env: CloudflareBindings, ctx?: ExecutionContext) => Promise<void>

/**
 * The scan reaper (ScanService.reap): queues again the steps of items stuck in a working state, fails the ones stuck for
 * over 2 hours. It reads no request context, so it needs no actor. A failure is logged and rethrown so Cloudflare records
 * the run as failed; the next sweep, 10 minutes on, looks at the same items again.
 */
export const createScanReaper = (): ScheduledHandler => async (_controller, env) => {
  const job = 'scan-reaper'
  try {
    const { requeued, failed } = await buildContainer(env).scans.reap(new Date())
    console.log({ job, outcome: 'done', requeued, failed })
  } catch (error) {
    console.error({ job, outcome: 'failed', error: describeError(error) })
    throw error
  }
}

/**
 * The Worker's `scheduled` export: one handler for every cron, which runs the job of the cron that fired and no other.
 * Without this the daily cleanup would run on every cron there is.
 */
export const createScheduledRouter = (): ScheduledHandler => {
  const jobs = new Map<string, ScheduledHandler>([
    [GUEST_CLEANUP_CRON, createGuestCleanup()],
    [SCAN_REAPER_CRON, createScanReaper()],
  ])
  return async (controller, env, ctx) => {
    const job = jobs.get(controller.cron)
    if (!job) {
      console.error({ outcome: 'unknown-cron', cron: controller.cron })
      return
    }
    await job(controller, env, ctx)
  }
}

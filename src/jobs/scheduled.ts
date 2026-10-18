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
 * over 2 hours. It then fills the search text of products that have none (ProductCatalogService.fillSearchText), also when the sweep failed. It reads no request context, so it needs no actor. A sweep failure is logged and rethrown (after the fill) so Cloudflare records
 * the run as failed; the next sweep, 10 minutes on, looks at the same items again.
 */
export const createScanReaper = (): ScheduledHandler => async (_controller, env) => {
  const job = 'scan-reaper'
  const container = buildContainer(env)
  let sweepFailed = false
  let sweepError: unknown
  try {
    const { requeued, failed } = await container.scans.reap(new Date())
    console.log({ job, outcome: 'done', requeued, failed })
  } catch (error) {
    console.error({ job, outcome: 'failed', error: describeError(error) })
    sweepFailed = true
    sweepError = error
  }
  // Catalog upkeep rides on this cron: search text for products a Worker that did not know the column made. After the sweep, which is the
  // job's purpose and spends the Worker's subrequests first; in its own try, so a failure here never fails the sweep nor is hidden by it.
  try {
    const filled = await container.catalog.fillSearchText()
    if (filled > 0) console.log({ job, outcome: 'search-text-filled', filled })
  } catch (error) {
    console.error({ job, outcome: 'search-text-fill-failed', error: describeError(error) })
  }
  if (sweepFailed) throw sweepError
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
      // Thrown, not just logged, so Cloudflare records the run as failed: a cron wrangler.jsonc gives the Worker that this file does not know is a config mistake.
      console.error({ outcome: 'unknown-cron', cron: controller.cron })
      throw new Error(`No job for the cron ${controller.cron}`)
    }
    await job(controller, env, ctx)
  }
}

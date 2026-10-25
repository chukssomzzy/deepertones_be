import type { z } from 'zod'
import type { Container } from '../container'
import { analyseFaceScan } from '../modules/face-scans/face-scans.jobs'
import { checkPushReceipts, sendPush } from '../modules/notifications/notifications.jobs'
import { sendOpsAlert } from '../modules/ops-alerts/ops-alerts.jobs'
import { deliverOtp } from '../modules/otp/otp.jobs'
import { parseSafety } from '../modules/safety/safety.jobs'
import { advanceScanItem } from '../modules/scans/scans.jobs'
import { buildVerdict } from '../modules/verdicts/verdicts.jobs'
import type { JobDefinition } from './job'

/** Every background job. Only the Worker entry (src/index.ts) imports this; lint:arch enforces it. */
export const jobs: JobDefinition<z.ZodType, Container>[] = [deliverOtp, advanceScanItem, sendPush, checkPushReceipts, sendOpsAlert, parseSafety, analyseFaceScan, buildVerdict]

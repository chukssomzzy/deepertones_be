import { z } from 'zod'
import { jobSpec } from '../../jobs/job'
import { REJECTED_PHOTO_REASONS } from '../../providers/perfect-corp/perfect-corp.provider'

export const NOTIFICATION_KINDS = ['scan-finished', 'scan-needs-you', 'new-sign-in', 'face-scan-ready', 'face-scan-needs-retake', 'face-check-in-due', 'routine-reminder', 'step-down-alert', 'missed-days-nudge', 'pause-check-in'] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

const scanFinishedBody = z.object({
  kind: z.literal('scan-finished'),
  userId: z.string(),
  profileId: z.string(),
  scanId: z.string(),
  /** How many products came out analysed; 0 is allowed (the text then says nothing about a count). */
  readyCount: z.number().int().min(0),
})

const scanNeedsYouBody = z.object({
  kind: z.literal('scan-needs-you'),
  userId: z.string(),
  profileId: z.string(),
  scanId: z.string(),
  itemId: z.string(),
  need: z.enum(['back-photo', 'confirm', 'identify']),
  /** Which time this item asks again after an unreadable back photo; absent or 0 is the first ask. */
  ask: z.number().int().min(0).optional(),
})

const newSignInBody = z.object({
  kind: z.literal('new-sign-in'),
  userId: z.string(),
  platform: z.enum(['ios', 'android']).nullable(),
  /** One per sign-in, so each alert is its own notification. The caller may name it, so a repeated call for one sign-in is one alert. */
  eventId: z.string(),
  /** When the sign-in happened, epoch ms. Only phones whose row existed before it are alerted: a row created later is the phone that signed in. */
  at: z.number().int(),
})

const faceScanReadyBody = z.object({
  kind: z.literal('face-scan-ready'),
  userId: z.string(),
  profileId: z.string(),
  faceScanId: z.string(),
})

const faceScanNeedsRetakeBody = z.object({
  kind: z.literal('face-scan-needs-retake'),
  userId: z.string(),
  profileId: z.string(),
  faceScanId: z.string(),
  reason: z.enum(REJECTED_PHOTO_REASONS),
  /** When the scan went to needs-retake, epoch ms (the `updatedAt` written). Retakes are unlimited, so each rejection is its own notification. */
  at: z.number().int(),
})

const faceCheckInDueBody = z.object({
  kind: z.literal('face-check-in-due'),
  userId: z.string(),
  profileId: z.string(),
  /** The chase's day-one scan: one chase is one notification. */
  dayOneScanId: z.string(),
})

const routineReminderBody = z.object({
  kind: z.literal('routine-reminder'),
  profileId: z.string(),
  /** The profile's local day, 'YYYY-MM-DD': what the "Done" action posts to the check-in route. */
  day: z.string(),
  time: z.enum(['morning', 'evening']),
  /** The entry titles the phone shows. Unlike the other kinds' text it is carried, since only the send job that queues it knows which entries are due; it is never logged. */
  title: z.string().min(1).max(200),
  /** The inbox row of the same reminder, when it could be written: the app posts it to the tap route to mark the row read. */
  inboxId: z.string().optional(),
})

const stepDownAlertBody = z.object({
  kind: z.literal('step-down-alert'),
  profileId: z.string(),
  /** The profile's local day, 'YYYY-MM-DD', on which the steps listed begin. */
  day: z.string(),
  /** One per step-down whose step begins that day: the product's routine title and the step's fixed line. Carried like the routine reminder's title, since only the send job knows which are due; never logged. */
  changes: z.array(z.object({ title: z.string().min(1), line: z.string().min(1) })).min(1),
  /** The inbox row of the same alert, when it could be written. */
  inboxId: z.string().optional(),
})

const missedDaysNudgeBody = z.object({
  kind: z.literal('missed-days-nudge'),
  profileId: z.string(),
  /** The first day of the run of missed days, 'YYYY-MM-DD': what makes the nudge once per run. */
  since: z.string(),
})

const pauseCheckInBody = z.object({
  kind: z.literal('pause-check-in'),
  profileId: z.string(),
  pauseId: z.string(),
  /** The pause's check day, 'YYYY-MM-DD': what makes the push once per check day (an answer of about the same moves it, and that is a new push). */
  checkDay: z.string(),
  /** The inbox row of the same check-in (`check-in-due`), when it could be written. */
  inboxId: z.string().optional(),
})

/**
 * Not a push: the 15-minute reminder cron's message for one started profile (PR 8a). It rides the push queue because the push consumer is the one already deployed for reminder work;
 * the consumer does that profile's reminder work (ReminderSendsService.sendForProfile) for the quarter hour the cron was scheduled for, `slot` (epoch ms), never for the moment it runs.
 */
const reminderProfileBody = z.object({
  kind: z.literal('reminder-profile'),
  profileId: z.string(),
  slot: z.number().int(),
})

/**
 * What the send job carries: the kind and ids only, never a token or a link (the routine reminder's title and the step-down alert's changes are the only text, see their bodies). Those are resolved when the job runs, so a
 * logout, a profile switch or a changed setting between the event and the send is respected.
 */
export const sendPushSpec = jobSpec({
  name: 'send-push',
  queue: 'push-delivery',
  schema: z.discriminatedUnion('kind', [scanFinishedBody, scanNeedsYouBody, newSignInBody, faceScanReadyBody, faceScanNeedsRetakeBody, faceCheckInDueBody, routineReminderBody, stepDownAlertBody, missedDaysNudgeBody, pauseCheckInBody, reminderProfileBody]),
  // One key per notification occurrence, so a repeated message sends nothing. A person scanning ten products gets one
  // needs-you push per scan and need; an item that asks again after an unreadable back photo is one more.
  key: (body) => {
    switch (body.kind) {
      case 'scan-finished':
        return `scan-finished:${body.scanId}`
      case 'scan-needs-you':
        return body.ask !== undefined && body.ask >= 1
          ? `scan-needs-you:${body.scanId}:${body.itemId}:ask-${body.ask}`
          : `scan-needs-you:${body.scanId}:${body.need}`
      case 'new-sign-in':
        return `new-sign-in:${body.eventId}`
      case 'face-scan-ready':
        return `face-scan-ready:${body.faceScanId}`
      case 'face-scan-needs-retake':
        return `face-scan-needs-retake:${body.faceScanId}:${body.at}`
      case 'face-check-in-due':
        return `face-check-in-due:${body.dayOneScanId}`
      case 'routine-reminder':
        return `routine-reminder:${body.profileId}:${body.day}:${body.time}`
      case 'step-down-alert':
        return `step-down-alert:${body.profileId}:${body.day}`
      case 'missed-days-nudge':
        return `missed-days-nudge:${body.profileId}:${body.since}`
      case 'pause-check-in':
        return `pause-check-in:${body.profileId}:${body.pauseId}:${body.checkDay}`
      case 'reminder-profile':
        return `reminder-profile:${body.profileId}:${body.slot}`
    }
  },
  // A person is waiting for the notification, as with an OTP: 5 attempts finish within a couple of minutes.
  retry: { baseSeconds: 5, factor: 3, capSeconds: 135 },
})

/**
 * The receipt check for the tickets of one send. It names each ticket's device by hash, and the token by its SHA-256, so no
 * push token is ever in a queue message; the token hash lets the check refuse to delete a phone that has a new token since.
 */
export const checkPushReceiptsSpec = jobSpec({
  name: 'check-push-receipts',
  queue: 'push-receipts',
  schema: z.object({ receipts: z.array(z.object({ ticketId: z.string(), deviceHash: z.string(), tokenHash: z.string() })) }),
  key: (body) => body.receipts.map((receipt) => receipt.ticketId).join(','),
  // Nobody waits for this: retry more patiently than a send.
  retry: { baseSeconds: 30, factor: 3, capSeconds: 600 },
})

export type SendPushMessage = z.infer<typeof sendPushSpec.schema>
/** A message of the send job that is a notification: every kind but the reminder cron's profile message. */
export type PushNotificationMessage = Exclude<SendPushMessage, { kind: 'reminder-profile' }>
export type CheckPushReceiptsMessage = z.infer<typeof checkPushReceiptsSpec.schema>

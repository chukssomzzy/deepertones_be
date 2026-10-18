import { z } from 'zod'
import { jobSpec } from '../../jobs/job'

export const NOTIFICATION_KINDS = ['scan-finished', 'scan-needs-you', 'new-sign-in'] as const
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
  need: z.enum(['back-photo', 'confirm']),
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

/**
 * What the send job carries: the kind and ids only, never a token, text or link. Those are resolved when the job runs, so a
 * logout, a profile switch or a changed setting between the event and the send is respected.
 */
export const sendPushSpec = jobSpec({
  name: 'send-push',
  queue: 'push-delivery',
  schema: z.discriminatedUnion('kind', [scanFinishedBody, scanNeedsYouBody, newSignInBody]),
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
export type CheckPushReceiptsMessage = z.infer<typeof checkPushReceiptsSpec.schema>

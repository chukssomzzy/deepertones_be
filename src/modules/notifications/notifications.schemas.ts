import { z } from '@hono/zod-openapi'

const Platform = z.enum(['ios', 'android'])

// The same device id the app sends to /auth/anonymous and /auth/logout, so its keyed hash is the devices table's.
const DeviceId = z.string().min(16).max(200).openapi({
  description: 'The same stable install id the app sends to `/api/v1/auth/anonymous`.',
})

export const RegisterPushTokenBody = z
  .object({
    deviceId: DeviceId,
    platform: Platform,
    token: z.string().min(1).max(256).openapi({
      description: 'The Expo push token, `ExponentPushToken[...]`. Anything else is 400 `PUSH_TOKEN_INVALID`.',
      example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
    }),
  })
  .openapi('RegisterPushTokenBody')

export const UnregisterPushTokenBody = z.object({ deviceId: DeviceId }).openapi('UnregisterPushTokenBody')

export const UpdateNotificationSettingsBody = z
  .object({
    scanFinished: z.boolean().optional().openapi({ description: 'Tell me when a scan is ready.' }),
    scanNeedsYou: z.boolean().optional().openapi({ description: 'Tell me when a scan needs a photo or a confirmation from me.' }),
  })
  .refine((body) => body.scanFinished !== undefined || body.scanNeedsYou !== undefined, { message: 'Name at least one setting' })
  .openapi('UpdateNotificationSettingsBody')

export const NotificationSettingsResponse = z
  .object({
    scanFinished: z.boolean(),
    scanNeedsYou: z.boolean(),
  })
  .openapi('NotificationSettings')

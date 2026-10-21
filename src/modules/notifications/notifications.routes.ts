import { defineRoute, errorResponses, jsonBody, ok, openapiApp, success } from '../../lib/openapi'
import { toNotificationSettingsResponse } from './notifications.presenter'
import {
  NotificationSettingsResponse,
  RegisterPushTokenBody,
  UnregisterPushTokenBody,
  UpdateNotificationSettingsBody,
} from './notifications.schemas'

const bearer = [{ bearerAuth: [] }]

const registerPushToken = defineRoute({
  method: 'put',
  path: '/push-token',
  operationId: 'registerPushToken',
  tags: ['Notifications'],
  summary: 'Register this phone to receive push notifications',
  description:
    'Guests included. The phone is stored for the session\'s account and profile, so call it after every sign-in, logout, profile switch and token refresh. ' +
    'Registering a device again moves it to the new token, account or profile; a token another device held moves to this one.',
  security: bearer,
  request: { body: jsonBody(RegisterPushTokenBody) },
  responses: { 204: { description: 'The phone is registered' }, ...errorResponses(401) },
})

const unregisterPushToken = defineRoute({
  method: 'delete',
  path: '/push-token',
  operationId: 'unregisterPushToken',
  tags: ['Notifications'],
  summary: 'Stop push notifications to this phone',
  description: 'Idempotent: a phone with no registration, or one registered to another account, is left alone and still answers 204.',
  security: bearer,
  request: { body: jsonBody(UnregisterPushTokenBody) },
  responses: { 204: { description: 'The phone is no longer registered to this account' }, ...errorResponses(401) },
})

const getNotificationSettings = defineRoute({
  method: 'get',
  path: '/notification-settings',
  operationId: 'getNotificationSettings',
  tags: ['Notifications'],
  summary: 'Which notifications the account wants',
  description: 'Both are on until changed, and they cover face scans too: the first for a scan that is ready, the second for a photo that needs a retake. The phone\'s own permission is the master switch.',
  security: bearer,
  responses: { 200: success(NotificationSettingsResponse, 'The account\'s settings'), ...errorResponses(401) },
})

const updateNotificationSettings = defineRoute({
  method: 'patch',
  path: '/notification-settings',
  operationId: 'updateNotificationSettings',
  tags: ['Notifications'],
  summary: 'Turn scan notifications on or off',
  description: 'Name the settings to change; the rest keep their value. The account\'s profiles share one set. The switches cover face scans too: `scanFinished` for a face scan that is ready, `scanNeedsYou` for a face photo that needs a retake.',
  security: bearer,
  request: { body: jsonBody(UpdateNotificationSettingsBody) },
  responses: { 200: success(NotificationSettingsResponse, 'All of the account\'s settings, after the change'), ...errorResponses(401) },
})

export const notificationsRoutes = openapiApp()
  .openapi(registerPushToken, async (c) => {
    await c.var.services.notifications.register(c.req.valid('json'))
    return c.body(null, 204)
  })
  .openapi(unregisterPushToken, async (c) => {
    await c.var.services.notifications.unregister(c.req.valid('json'))
    return c.body(null, 204)
  })
  .openapi(getNotificationSettings, async (c) =>
    ok(c, toNotificationSettingsResponse(await c.var.services.notifications.settings()), 'Notification settings'),
  )
  .openapi(updateNotificationSettings, async (c) =>
    ok(c, toNotificationSettingsResponse(await c.var.services.notifications.updateSettings(c.req.valid('json'))), 'Notification settings updated'),
  )

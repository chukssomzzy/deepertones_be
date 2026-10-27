import { defineRoute, errorResponses, jsonBody, ok, openapiApp, success } from '../../lib/openapi'
import { signedIn } from '../../middleware/signed-in'
import { toRemindersResponse } from './reminders.presenter'
import { RemindersResponse, UpdateRemindersBody } from './reminders.schemas'

const bearer = [{ bearerAuth: [] }]

const getReminders = defineRoute({
  method: 'get',
  path: '/reminders',
  operationId: 'getReminders',
  tags: ['Reminders'],
  summary: 'When and how the profile wants to be reminded',
  description:
    'For a signed-up account: 401 without a session, 403 `SIGNUP_REQUIRED` for a guest. Reminders are off until turned on; the defaults are 07:00 and 21:00 with no time zone, and both alerts on. ' +
    'Each profile has its own settings.',
  security: bearer,
  responses: { 200: success(RemindersResponse, 'The profile\'s reminder settings'), ...errorResponses(401, 403) },
})

const updateReminders = defineRoute({
  method: 'put',
  path: '/reminders',
  operationId: 'updateReminders',
  tags: ['Reminders'],
  summary: 'Change the reminder settings',
  description:
    'Name the settings to change; the rest keep their value. At least one is required, and `missedDaysChannel` is read-only, so sending it is 400 `VALIDATION_FAILED`. ' +
    'A body of only `timeZone` is fine: the phone sends it whenever its zone changes. The time zone also decides where the profile\'s local days begin (routine start and step-down dates).',
  security: bearer,
  // An unsigned caller is turned away before the body is checked, so a bodiless request answers 401 and not 400.
  middleware: [signedIn()],
  request: { body: jsonBody(UpdateRemindersBody) },
  responses: { 200: success(RemindersResponse, 'All of the profile\'s settings, after the change'), ...errorResponses(401, 403) },
})

export const remindersRoutes = openapiApp()
  .openapi(getReminders, async (c) => ok(c, toRemindersResponse(await c.var.services.reminders.settings()), 'Reminder settings'))
  .openapi(updateReminders, async (c) => ok(c, toRemindersResponse(await c.var.services.reminders.update(c.req.valid('json'))), 'Reminder settings updated'))

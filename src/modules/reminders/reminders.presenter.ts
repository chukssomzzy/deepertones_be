import type { z } from '@hono/zod-openapi'
import type { RemindersResponse } from './reminders.schemas'
import type { ReminderSettingsView } from './reminders.service'

export const toRemindersResponse = ({
  enabled,
  morning,
  evening,
  timeZone,
  stepDownAlerts,
  missedDaysNudge,
  missedDaysChannel,
}: ReminderSettingsView): z.infer<typeof RemindersResponse> => ({ enabled, morning, evening, timeZone, stepDownAlerts, missedDaysNudge, missedDaysChannel })

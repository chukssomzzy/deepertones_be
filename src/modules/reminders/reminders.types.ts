import type { reminderSettings } from './reminders.table'

export type ReminderSettings = typeof reminderSettings.$inferSelect

/** The settings a change names; the ones left out keep their value. A null `timeZone` clears the zone. */
export type ReminderSettingsPatch = Partial<Omit<ReminderSettings, 'profileId' | 'updatedAt'>>

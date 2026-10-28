import type { Frequency, RoutineStep } from '../catalog/catalog.vocabulary'
import type { reminderSettings } from './reminders.table'

export type ReminderSettings = typeof reminderSettings.$inferSelect

/** The settings a change names; the ones left out keep their value. A null `timeZone` clears the zone. */
/**
 * A profile with a Started routine and its reminder settings, as the 15-minute cron reads them in one statement: the settings columns are null when the profile has no
 * settings row. (Reminders may not import routines, so this is the narrow type the routines side answers.)
 */
export type StartedProfile = { profileId: string; enabled: boolean | null; morning: string | null; evening: string | null; timeZone: string | null }

export type ReminderSettingsPatch = Partial<Omit<ReminderSettings, 'profileId' | 'updatedAt'>>

/** One entry of a routine list as the send job reads it: the routine's title for the step, and the step's raw frequency. */
export type PlanEntry = { step: RoutineStep; title: string; frequency: Frequency; anchor?: string }

/** One day a step of a step-down begins: the product's routine title and the step's fixed line ("From today: use it every other day"), already past the wording gate. */
export type StepDownChange = { day: string; title: string; line: string }

/**
 * The routine as the send job needs it: day 1 (a calendar date, 'YYYY-MM-DD'), the morning and evening lists and the days a step-down changes. This module owns the type so it never imports routines;
 * `RoutineViewerService.reminderPlanFor` answers it, and the container hands that over.
 */
export type ReminderRoutinePlan = { dayOne: string; morning: PlanEntry[]; evening: PlanEntry[]; stepDownChanges: StepDownChange[] }

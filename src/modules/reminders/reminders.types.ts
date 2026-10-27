import type { Frequency, RoutineStep } from '../catalog/catalog.vocabulary'
import type { reminderSettings } from './reminders.table'

export type ReminderSettings = typeof reminderSettings.$inferSelect

/** The settings a change names; the ones left out keep their value. A null `timeZone` clears the zone. */
export type ReminderSettingsPatch = Partial<Omit<ReminderSettings, 'profileId' | 'updatedAt'>>

/** One entry of a routine list as the send job reads it: the routine's title for the step, and the step's raw frequency. */
export type PlanEntry = { step: RoutineStep; title: string; frequency: Frequency }

/**
 * The routine as the send job needs it: day 1 (a calendar date, 'YYYY-MM-DD') and the morning and evening lists. This module owns the type so it never imports routines;
 * `RoutineViewerService.reminderPlanFor` answers it, and the container hands that over.
 */
export type ReminderRoutinePlan = { dayOne: string; morning: PlanEntry[]; evening: PlanEntry[] }

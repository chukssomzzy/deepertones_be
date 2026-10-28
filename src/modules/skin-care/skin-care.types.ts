import type { skinLogs } from './skin-care.table'

export type SkinLog = typeof skinLogs.$inferSelect

/** A log as the service makes it: the caller makes the id and the time, and a new log is never overridden. */
export type NewSkinLog = Omit<SkinLog, 'overridden'>

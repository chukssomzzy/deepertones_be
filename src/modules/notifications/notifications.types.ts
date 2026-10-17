import type { notificationSettings, pushTokens } from './notifications.table'

export type PushToken = typeof pushTokens.$inferSelect

export type NotificationSettings = typeof notificationSettings.$inferSelect

/** The switches a change names; the ones left out keep their value. */
export type NotificationSettingsPatch = Partial<Pick<NotificationSettings, 'scanFinished' | 'scanNeedsYou'>>

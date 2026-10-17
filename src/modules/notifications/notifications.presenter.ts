import type { z } from '@hono/zod-openapi'
import type { NotificationSettingsResponse } from './notifications.schemas'
import type { ScanNotificationSettings } from './notifications.service'

export const toNotificationSettingsResponse = ({
  scanFinished,
  scanNeedsYou,
}: ScanNotificationSettings): z.infer<typeof NotificationSettingsResponse> => ({ scanFinished, scanNeedsYou })

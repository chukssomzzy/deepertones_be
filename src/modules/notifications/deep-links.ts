import deepLinks from './deep-links.json'
import type { NotificationKind } from './notifications.job-specs'

/** The ids a path template may name; which kind provides which is pinned by deep-links.test.ts. */
export type DeepLinkIds = { scanId?: string; itemId?: string }

/**
 * The Expo Router path a tap on this kind of notification opens: the kind's template from deep-links.json with each
 * `{placeholder}` filled by its URL-encoded id, so an id can never add a path segment or a query. The file ships with the
 * Worker; changing a path is a PR.
 */
export const deepLinkFor = (kind: NotificationKind, ids: DeepLinkIds): string =>
  (deepLinks as Record<NotificationKind, string>)[kind].replace(/\{(\w+)\}/g, (_match, name: keyof DeepLinkIds) => {
    const id = ids[name]
    if (id === undefined) throw new Error(`The deep link of ${kind} needs {${name}}, which the notification does not carry`)
    return encodeURIComponent(id)
  })

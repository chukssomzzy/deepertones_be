import { describe, expect, it } from 'vitest'
import deepLinks from './deep-links.json'
import { deepLinkFor } from './deep-links'
import { NOTIFICATION_KINDS } from './notifications.job-specs'

// Which ids each kind's notification carries, so which {placeholders} its path may use. Written out here, not read from the
// implementation: a new kind, or a path that asks for an id the notification does not have, must fail this file until the
// table (and the app's route) is updated on purpose.
const PROVIDED_IDS: Record<(typeof NOTIFICATION_KINDS)[number], string[]> = {
  'scan-finished': ['scanId'],
  'scan-needs-you': ['scanId', 'itemId'],
  'new-sign-in': [],
}

const templates = deepLinks as Record<string, string>
const placeholdersOf = (path: string) => [...path.matchAll(/\{([^}]*)\}/g)].map((match) => match[1]!)

describe('the deep-link table (deep-links.json)', () => {
  it('knows exactly the notification kinds: one path for each, and no path for a kind that does not exist', () => {
    expect(Object.keys(templates).sort()).toEqual([...NOTIFICATION_KINDS].sort())
    expect([...NOTIFICATION_KINDS].sort()).toEqual(Object.keys(PROVIDED_IDS).sort())
  })

  it.each(NOTIFICATION_KINDS)('gives %s a path that starts with "/", so the app can route it', (kind) => {
    expect(templates[kind]).toMatch(/^\//)
  })

  it.each(NOTIFICATION_KINDS)('uses only placeholders that %s provides', (kind) => {
    const provided = PROVIDED_IDS[kind]

    for (const placeholder of placeholdersOf(templates[kind]!)) {
      expect(provided, `{${placeholder}} in the path of ${kind}`).toContain(placeholder)
    }
  })

  it('uses every id its kind provides, so a tap opens the exact thing the notification is about', () => {
    expect(placeholdersOf(templates['scan-finished']!)).toEqual(['scanId'])
    expect(placeholdersOf(templates['scan-needs-you']!).sort()).toEqual(['itemId', 'scanId'])
    expect(placeholdersOf(templates['new-sign-in']!)).toEqual([])
  })
})

describe('deepLinkFor', () => {
  it('opens the scan for a finished scan', () => {
    expect(deepLinkFor('scan-finished', { scanId: 'scan-1' })).toBe('/scans/scan-1')
  })

  it('opens the exact item for a scan that needs the person', () => {
    expect(deepLinkFor('scan-needs-you', { scanId: 'scan-1', itemId: 'item-9' })).toBe('/scans/scan-1/items/item-9')
  })

  it('opens the security settings for a new sign-in, with no ids', () => {
    expect(deepLinkFor('new-sign-in', {})).toBe('/settings/security')
  })

  it('URL-encodes each filled value, so an id can never add a path segment or a query', () => {
    expect(deepLinkFor('scan-needs-you', { scanId: 'a b/c', itemId: '../x?y=1#z' })).toBe('/scans/a%20b%2Fc/items/..%2Fx%3Fy%3D1%23z')
  })

  it('leaves the ids of a kind that does not use them out of the path', () => {
    expect(deepLinkFor('new-sign-in', { scanId: 'scan-1' })).toBe('/settings/security')
  })
})

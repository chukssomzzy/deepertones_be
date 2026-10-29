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
  'face-scan-ready': ['faceScanId'],
  'face-scan-needs-retake': ['faceScanId'],
  'face-check-in-due': [],
  // The reminder opens the routine screen itself, whatever the day or time.
  'routine-reminder': [],
  // Both open a screen of the routine itself, whatever the day: neither carries an id (the alert's day and the nudge's run are in the payload for the app, not in the path).
  'step-down-alert': [],
  'missed-days-nudge': [],
  // The check-in after a pause is answered from Today on the routine screen, whatever the pause: no id in the path (the pause's id is in the payload for the app, not in the path).
  'pause-check-in': [],
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
    expect(placeholdersOf(templates['face-scan-ready']!)).toEqual(['faceScanId'])
    expect(placeholdersOf(templates['face-scan-needs-retake']!)).toEqual(['faceScanId'])
    expect(placeholdersOf(templates['face-check-in-due']!)).toEqual([])
    expect(placeholdersOf(templates['routine-reminder']!)).toEqual([])
    expect(placeholdersOf(templates['step-down-alert']!)).toEqual([])
    expect(placeholdersOf(templates['missed-days-nudge']!)).toEqual([])
    expect(placeholdersOf(templates['pause-check-in']!)).toEqual([])
  })

  it('writes the face scan paths exactly as the app routes them', () => {
    expect(templates['face-scan-ready']).toBe('/scans/faces/{faceScanId}')
    expect(templates['face-scan-needs-retake']).toBe('/scans/faces/{faceScanId}/retake')
  })
})

describe('the check-in-due deep link', () => {
  // A check-in is a new face scan, not a scan that exists yet, so the path is static and carries no id (issue #145).
  it('writes the path exactly as the app routes a new face scan', () => {
    expect(templates['face-check-in-due']).toBe('/scans/faces/new')
  })

  it('opens the new face scan screen, whatever ids it is given', () => {
    expect(deepLinkFor('face-check-in-due', {})).toBe('/scans/faces/new')
    expect(deepLinkFor('face-check-in-due', { faceScanId: 'face-1', scanId: 'scan-1' })).toBe('/scans/faces/new')
  })
})

describe('the routine reminder deep link', () => {
  it('opens the routine screen, whatever ids it is given', () => {
    expect(templates['routine-reminder']).toBe('/routine')
    expect(deepLinkFor('routine-reminder', {})).toBe('/routine')
    expect(deepLinkFor('routine-reminder', { scanId: 'scan-1' })).toBe('/routine')
  })
})

// ASSUMED paths (the brief says "its own deep link" and "the step-down schedule"; the app's routes decide, and these two lines are where the backend is told): the alert opens the
// step-down schedule, the nudge opens the routine, where the "Done" tick is.
describe('the step-down alert and missed-days nudge deep links', () => {
  it('opens the step-down schedule for the alert, whatever ids it is given', () => {
    expect(templates['step-down-alert']).toBe('/routine/step-down')
    expect(deepLinkFor('step-down-alert', {})).toBe('/routine/step-down')
    expect(deepLinkFor('step-down-alert', { scanId: 'scan-1' })).toBe('/routine/step-down')
  })

  it('opens the routine for the nudge, whatever ids it is given', () => {
    expect(templates['missed-days-nudge']).toBe('/routine')
    expect(deepLinkFor('missed-days-nudge', {})).toBe('/routine')
    expect(deepLinkFor('missed-days-nudge', { scanId: 'scan-1' })).toBe('/routine')
  })
})

// ASSUMED path (the brief says "give it a deep link"; the app's routes decide): the check-in after a pause is shown on Today until it is answered, so a tap opens the routine screen.
describe('the pause check-in deep link', () => {
  it('opens the routine, whatever ids it is given', () => {
    expect(templates['pause-check-in']).toBe('/routine')
    expect(deepLinkFor('pause-check-in', {})).toBe('/routine')
    expect(deepLinkFor('pause-check-in', { scanId: 'scan-1' })).toBe('/routine')
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

  it('opens the face scan for a face scan that is ready', () => {
    expect(deepLinkFor('face-scan-ready', { faceScanId: 'face-1' })).toBe('/scans/faces/face-1')
  })

  it('opens the retake screen of the face scan for a photo that needs a retake', () => {
    expect(deepLinkFor('face-scan-needs-retake', { faceScanId: 'face-1' })).toBe('/scans/faces/face-1/retake')
  })

  it('URL-encodes the face scan id too, so it can never add a path segment or a query', () => {
    expect(deepLinkFor('face-scan-ready', { faceScanId: 'a b/c?d' })).toBe('/scans/faces/a%20b%2Fc%3Fd')
    expect(deepLinkFor('face-scan-needs-retake', { faceScanId: '../x' })).toBe('/scans/faces/..%2Fx/retake')
  })

  it('refuses to build a face scan link when the notification carries no face scan id', () => {
    expect(() => deepLinkFor('face-scan-ready', { scanId: 'scan-1' })).toThrow(/faceScanId/)
  })

  it('URL-encodes each filled value, so an id can never add a path segment or a query', () => {
    expect(deepLinkFor('scan-needs-you', { scanId: 'a b/c', itemId: '../x?y=1#z' })).toBe('/scans/a%20b%2Fc/items/..%2Fx%3Fy%3D1%23z')
  })

  it('leaves the ids of a kind that does not use them out of the path', () => {
    expect(deepLinkFor('new-sign-in', { scanId: 'scan-1' })).toBe('/settings/security')
  })
})

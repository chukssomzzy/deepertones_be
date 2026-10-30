import { describe, expect, it } from 'vitest'
import { BRAND } from '../../emails/brand'
import type { Rect, ShareCardLayout } from '../../providers/share-card/share-card.provider'
import { shareCardLayout } from './face-shares.layout'

// The before-and-after card's layout (spec #259, C2): where everything goes on the 1080 x 1920 canvas, as numbers. It is a pure function, so these tests prove the rules
// of the card without rendering anything: the boxes and bands never overlap, nothing leaves the canvas, both photos are treated alike, and the photos are only resized.
// A label's rect is the band reserved for its text, sized with room to spare for the text option's larger reading (points); where Cloudflare really puts the glyphs is
// not proven here, and the staging check confirms it.
//
// THE CONTRACT THIS FILE PINS (the brief fixes the rules; the names and the shape are the assumptions, so the implementer may only rename if this file is changed with it):
//   shareCardLayout(dayNumber: number): ShareCardLayout     the "after" label reads `Day ${dayNumber}`; the "before" label is always "Day 1"
//   Rect = { left, top, width, height }                      whole pixels, from the canvas's top left corner
//   ShareCardLayout = {
//     canvas: { width: 1080, height: 1920, background }      `background` is one colour of BRAND.colors, as a #rrggbb string
//     photos: { before: Placement, after: Placement }        Placement = { rect, fit }, with exactly those two keys: nothing else can be asked of a photo, so no colour,
//                                                            brightness, contrast, filter or blur can be. `fit` is 'cover' or 'contain', the same for both.
//     labels: { text: string; rect: Rect }[]                 exactly two, the before label first. Any other key (size, colour) is allowed. No other text is on the card.
//     logo: { rect: Rect }                                   in the bottom right corner, in the real logo's proportions (254 x 40)
//   }
// The layout does not depend on the photos' own sizes: the renderer fits each photo into its rect with `fit`, so portrait, square and landscape photos all land in the same boxes.

const CANVAS = { width: 1080, height: 1920 }
/** The real logo asset (assets/email/logo.png, the public email logo) is 254 x 40 pixels. */
const LOGO_ASPECT = 254 / 40
/** How far the logo's right and bottom edges may be from the canvas edges and still be "in the corner". */
const CORNER_MARGIN = 120
/** The photos are the point of the card: each box must be a substantial part of the canvas. */
const MIN_PHOTO_SHARE_OF_CANVAS = 0.25

const right = (rect: Rect) => rect.left + rect.width
const bottom = (rect: Rect) => rect.top + rect.height
const centre = (rect: Rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
/** Whether two rects share any area. Rects that only touch along an edge do not intersect. */
const intersects = (a: Rect, b: Rect) => a.left < right(b) && b.left < right(a) && a.top < bottom(b) && b.top < bottom(a)
const isInsideCanvas = (rect: Rect) => rect.left >= 0 && rect.top >= 0 && right(rect) <= CANVAS.width && bottom(rect) <= CANVAS.height
const distance = (a: Rect, b: Rect) => Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y)

/** A day number small and large enough to change the width of "Day N": the label must fit and stay clear of the photos at every length. */
const DAY_NUMBERS = [15, 100, 999]

const layoutFor = (dayNumber: number): ShareCardLayout => shareCardLayout(dayNumber)
const everyRect = (layout: ShareCardLayout): Rect[] => [layout.photos.before.rect, layout.photos.after.rect, ...layout.labels.map((label) => label.rect), layout.logo.rect]

describe('the intersects helper this file relies on', () => {
  it('counts overlapping rects as intersecting and rects that only share an edge as clear', () => {
    expect(intersects({ left: 0, top: 0, width: 10, height: 10 }, { left: 5, top: 5, width: 10, height: 10 })).toBe(true)
    expect(intersects({ left: 0, top: 0, width: 10, height: 10 }, { left: 10, top: 0, width: 10, height: 10 })).toBe(false)
    expect(intersects({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 10, width: 10, height: 10 })).toBe(false)
  })
})

describe('shareCardLayout', () => {
  it('is a 1080 x 1920 canvas in one plain brand colour', () => {
    const { canvas } = layoutFor(15)

    expect(canvas.width).toBe(CANVAS.width)
    expect(canvas.height).toBe(CANVAS.height)
    expect(canvas.background).toMatch(/^#[0-9a-f]{6}$/i)
    expect(Object.values(BRAND.colors).map((colour) => colour.toLowerCase())).toContain(canvas.background.toLowerCase())
  })

  it.each(DAY_NUMBERS)('puts two photo boxes of the same size on the canvas, the before photo above the after photo, without touching (Day %i)', (day) => {
    const { before, after } = layoutFor(day).photos

    expect(before.rect.width).toBe(after.rect.width)
    expect(before.rect.height).toBe(after.rect.height)
    expect(before.rect.left).toBe(after.rect.left)
    expect(bottom(before.rect)).toBeLessThanOrEqual(after.rect.top)
    expect(intersects(before.rect, after.rect)).toBe(false)
  })

  it('makes each photo box a substantial part of the canvas', () => {
    const { before, after } = shareCardLayout(15).photos
    const canvasArea = CANVAS.width * CANVAS.height

    expect((before.rect.width * before.rect.height) / canvasArea).toBeGreaterThanOrEqual(MIN_PHOTO_SHARE_OF_CANVAS)
    expect((after.rect.width * after.rect.height) / canvasArea).toBeGreaterThanOrEqual(MIN_PHOTO_SHARE_OF_CANVAS)
  })

  it.each(DAY_NUMBERS)('fits both photos with the same rule, and the rule is a resize and nothing else (Day %i)', (day) => {
    const { before, after } = layoutFor(day).photos

    expect(before.fit).toBe(after.fit)
    expect(['cover', 'contain']).toContain(before.fit)
    // Exactly a box and a fit: there is no key to carry a colour, brightness, contrast, filter or blur operation.
    expect(Object.keys(before).sort()).toEqual(['fit', 'rect'])
    expect(Object.keys(after).sort()).toEqual(['fit', 'rect'])
  })

  it.each(DAY_NUMBERS)('labels the photos "Day 1" and "Day N" and writes nothing else (Day %i)', (day) => {
    const { labels } = layoutFor(day)

    expect(labels.map((label) => label.text)).toEqual(['Day 1', `Day ${day}`])
  })

  it.each(DAY_NUMBERS)('keeps both labels clear of both photo boxes, so a label is never over a face (Day %i)', (day) => {
    const layout = layoutFor(day)

    for (const label of layout.labels) {
      expect(intersects(label.rect, layout.photos.before.rect)).toBe(false)
      expect(intersects(label.rect, layout.photos.after.rect)).toBe(false)
    }
  })

  it.each(DAY_NUMBERS)('puts each label nearer its own photo than the other one, so "Day 1" is never read as the after photo (Day %i)', (day) => {
    const { labels, photos } = layoutFor(day)
    const [beforeLabel, afterLabel] = labels.map((label) => label.rect)

    expect(distance(beforeLabel!, photos.before.rect)).toBeLessThan(distance(beforeLabel!, photos.after.rect))
    expect(distance(afterLabel!, photos.after.rect)).toBeLessThan(distance(afterLabel!, photos.before.rect))
  })

  it.each(DAY_NUMBERS)('puts the logo in the bottom right corner, fully outside both photo boxes (Day %i)', (day) => {
    const layout = layoutFor(day)
    const { rect } = layout.logo

    expect(intersects(rect, layout.photos.before.rect)).toBe(false)
    expect(intersects(rect, layout.photos.after.rect)).toBe(false)
    expect(right(rect)).toBeGreaterThanOrEqual(CANVAS.width - CORNER_MARGIN)
    expect(bottom(rect)).toBeGreaterThanOrEqual(CANVAS.height - CORNER_MARGIN)
  })

  it('draws the logo in the real logo\'s proportions, so it is not stretched', () => {
    const { rect } = layoutFor(15).logo

    expect(rect.width / rect.height).toBeCloseTo(LOGO_ASPECT, 0)
    expect(Math.abs(rect.width / rect.height - LOGO_ASPECT) / LOGO_ASPECT).toBeLessThan(0.03)
  })

  it.each(DAY_NUMBERS)('keeps the logo clear of the labels (Day %i)', (day) => {
    const layout = layoutFor(day)

    for (const label of layout.labels) expect(intersects(layout.logo.rect, label.rect)).toBe(false)
  })

  it.each(DAY_NUMBERS)('puts every element inside the canvas, in whole pixels (Day %i)', (day) => {
    for (const rect of everyRect(layoutFor(day))) {
      expect(isInsideCanvas(rect)).toBe(true)
      expect(rect.width).toBeGreaterThan(0)
      expect(rect.height).toBeGreaterThan(0)
      for (const value of [rect.left, rect.top, rect.width, rect.height]) expect(Number.isInteger(value)).toBe(true)
    }
  })

  it('answers the same layout for the same day, with only the after label changing between days', () => {
    const fifteen = shareCardLayout(15)
    const hundred = shareCardLayout(100)

    expect(shareCardLayout(15)).toEqual(fifteen)
    expect(hundred.photos).toEqual(fifteen.photos)
    expect(hundred.logo).toEqual(fifteen.logo)
    expect(hundred.labels[0]!.text).toBe('Day 1')
    expect(hundred.labels[1]!.text).toBe('Day 100')
  })
})

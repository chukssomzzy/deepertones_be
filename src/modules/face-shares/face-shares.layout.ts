import { BRAND } from '../../emails/brand'
import type { Placement, Rect, ShareCardLayout } from '../../providers/share-card/share-card.provider'

const CANVAS = { width: 1080, height: 1920 }
const MARGIN = 24
const LABEL_GAP = 8
/** More room above the "after" label than below it, so it reads as belonging to the photo under it and not to the one above. */
const SECTION_GAP = 24
const LABEL_SIZE = 30
// Cloudflare documents the text size in points in its types and in pixels on its docs page, so a band must hold the larger reading: points to pixels is 4/3, a line is
// taken as 1.5 times that, and there is padding above and below. The staging check confirms where the glyphs really land.
const LABEL_LINE_PX = Math.ceil(Math.ceil((LABEL_SIZE * 4) / 3) * 1.5)
const LABEL_PADDING = 6
const LABEL_HEIGHT = LABEL_LINE_PX + 2 * LABEL_PADDING
/** The real logo asset (the public email logo) is 254 x 40. */
const LOGO = BRAND.logo
const LOGO_TOP = CANVAS.height - MARGIN - LOGO.height
/** Both boxes take what the canvas has left between the top margin and the logo's row, after the two label bands and the gaps; the width is 4:5, a little wider than a phone's 3:4 photo. */
const PHOTO_HEIGHT = Math.floor((LOGO_TOP - LABEL_GAP - MARGIN - 2 * (LABEL_HEIGHT + LABEL_GAP) - SECTION_GAP) / 2)
const PHOTO_WIDTH = 2 * Math.floor((PHOTO_HEIGHT * 4) / 5 / 2)

/**
 * Where everything goes on the before-and-after card: 1080 x 1920, one plain brand colour, the day-one photo above the later one in boxes of the same size, each photo with a
 * "Day N" label in its own band outside the photo, and the logo bottom right. Nothing else is written on it: no caption, goal, score or result. Pure; the photos' own sizes do
 * not matter because the renderer fits each into its box.
 */
export const shareCardLayout = (dayNumber: number): ShareCardLayout => {
  const left = (CANVAS.width - PHOTO_WIDTH) / 2
  const labelBand = (top: number): Rect => ({ left, top, width: PHOTO_WIDTH, height: LABEL_HEIGHT })
  const photoBox = (top: number): Rect => ({ left, top, width: PHOTO_WIDTH, height: PHOTO_HEIGHT })
  const placement = (top: number): Placement => ({ rect: photoBox(top), fit: 'contain' })

  const beforeLabelTop = MARGIN
  const beforeTop = beforeLabelTop + LABEL_HEIGHT + LABEL_GAP
  const afterLabelTop = beforeTop + PHOTO_HEIGHT + SECTION_GAP
  const afterTop = afterLabelTop + LABEL_HEIGHT + LABEL_GAP

  const label = (text: string, top: number) => ({ text, rect: labelBand(top), size: LABEL_SIZE, color: BRAND.colors.lightText })
  return {
    canvas: { ...CANVAS, background: BRAND.colors.header },
    photos: { before: placement(beforeTop), after: placement(afterTop) },
    labels: [label('Day 1', beforeLabelTop), label(`Day ${dayNumber}`, afterLabelTop)],
    logo: { rect: { left: CANVAS.width - MARGIN - LOGO.width, top: LOGO_TOP, width: LOGO.width, height: LOGO.height } },
  }
}

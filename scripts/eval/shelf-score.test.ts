import { describe, expect, it } from 'vitest'
import { scoreShelf, summariseShelf } from './shelf-score'

const item = (brand: string, name: string) => ({ brand, name })

const SERUM = item('Glow Co', 'Bright Tone Serum')
const CREAM = item('NIVEA', 'Soft Cream')
const SOAP = item('Dove', 'Beauty Bar')
const OIL = item('Nuxe', 'Huile Prodigieuse')

describe('scoreShelf', () => {
  it('scores a shelf read perfectly as recall 1 and precision 1', () => {
    const score = scoreShelf([SERUM, CREAM], [CREAM, SERUM])

    expect(score).toMatchObject({ expected: 2, found: 2, matched: 2, recall: 1, precision: 1, missing: [], extra: [] })
  })

  it('counts a product the model missed against recall only, and names it', () => {
    const score = scoreShelf([SERUM, CREAM, SOAP, OIL], [SERUM, CREAM, SOAP])

    expect(score).toMatchObject({ expected: 4, found: 3, matched: 3, recall: 0.75, precision: 1 })
    expect(score.missing).toEqual([OIL])
    expect(score.extra).toEqual([])
  })

  it('counts a product the model invented against precision only, and names it', () => {
    const score = scoreShelf([SERUM, CREAM], [SERUM, CREAM, SOAP, OIL])

    expect(score).toMatchObject({ expected: 2, found: 4, matched: 2, recall: 1, precision: 0.5 })
    expect(score.extra).toEqual([SOAP, OIL])
    expect(score.missing).toEqual([])
  })

  it('matches brand and name regardless of case, surrounding spaces and repeated inner spaces', () => {
    const score = scoreShelf([SERUM], [item('  GLOW   co ', 'bright tone  SERUM')])

    expect(score).toMatchObject({ matched: 1, recall: 1, precision: 1 })
  })

  it('does not match when only the brand or only the name agrees', () => {
    const score = scoreShelf([SERUM], [item('Glow Co', 'Night Serum'), item('Other Co', 'Bright Tone Serum')])

    expect(score).toMatchObject({ matched: 0, recall: 0, precision: 0 })
  })

  it('does not let one expected product match two found ones', () => {
    const score = scoreShelf([SERUM], [SERUM, SERUM])

    expect(score).toMatchObject({ expected: 1, found: 2, matched: 1, recall: 1, precision: 0.5 })
    expect(score.extra).toEqual([SERUM])
  })

  it('scores recall 0 and precision 0 when nothing found matches', () => {
    expect(scoreShelf([SERUM], [SOAP])).toMatchObject({ matched: 0, recall: 0, precision: 0 })
  })

  it('scores an empty shelf with nothing found as perfect, and with something found as precision 0', () => {
    expect(scoreShelf([], [])).toMatchObject({ recall: 1, precision: 1 })
    expect(scoreShelf([], [SERUM])).toMatchObject({ recall: 1, precision: 0, extra: [SERUM] })
  })

  it('scores recall 0 and a vacuous precision of 1 when the model found nothing on a shelf with products', () => {
    expect(scoreShelf([SERUM], [])).toMatchObject({ recall: 0, precision: 1, missing: [SERUM] })
  })
})

describe('summariseShelf', () => {
  it('totals matched, expected and found over every photo and gives overall recall and precision', () => {
    const photos = [scoreShelf([SERUM, CREAM], [SERUM]), scoreShelf([SOAP, OIL, SERUM], [SOAP, OIL, SERUM, CREAM])]

    expect(summariseShelf(photos)).toMatchObject({ photos: 2, expected: 5, found: 5, matched: 4, recall: 0.8, precision: 0.8 })
  })

  it('weights by product, not by photo, so a big shelf counts for more than a small one', () => {
    const photos = [scoreShelf([SERUM], [SERUM]), scoreShelf([SOAP, OIL, CREAM, SERUM], [])]

    // 1 of 5 expected found: recall 0.2, where averaging the photos' recall (1 and 0) would say 0.5.
    expect(summariseShelf(photos)).toMatchObject({ expected: 5, matched: 1, recall: 0.2 })
  })

  it('summarises no photos as zero photos with recall 1 and precision 1', () => {
    expect(summariseShelf([])).toMatchObject({ photos: 0, expected: 0, found: 0, matched: 0, recall: 1, precision: 1 })
  })
})

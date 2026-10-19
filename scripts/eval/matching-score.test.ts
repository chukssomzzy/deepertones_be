import { describe, expect, it } from 'vitest'
import {
  DUPLICATE_COST_USD,
  duplicateCost,
  exitCode,
  judge,
  scoreImages,
  scoreMatching,
  scoreOrder,
  type ImageOutcome,
  type PhotoOutcome,
} from './matching-score'

// Photo outcomes are listed in the order the photos were processed. A row id is just an opaque label for "the catalog row this photo landed on".

const read = (folder: string, rowId: string, how: 'exact-key' | 'judge-same' | 'new-row', extra: Partial<Extract<PhotoOutcome, { rowId: string }>> = {}): PhotoOutcome => ({
  folder,
  photo: `${folder}-${Math.random().toString(36).slice(2)}.jpg`,
  rowId,
  how,
  judged: [],
  differs: [],
  ...extra,
})
const unreadable = (folder: string): PhotoOutcome => ({ folder, photo: `${folder}-${Math.random().toString(36).slice(2)}.jpg`, unreadable: true })

const NO_LABELS = {}
const order = (photos: PhotoOutcome[], seed = 1) => ({ seed, photos })
const productOf = (score: ReturnType<typeof scoreOrder>, folder: string) => score.products.find((p) => p.folder === folder)!

describe('scoreOrder', () => {
  it('scores a product whose photos all land on one row as fully consistent with every repeat a hit', () => {
    const score = scoreOrder(order([read('serum', 'r1', 'new-row'), read('serum', 'r1', 'exact-key'), read('serum', 'r1', 'judge-same')]), NO_LABELS)

    expect(productOf(score, 'serum')).toMatchObject({ photos: 3, rows: 1, consistency: 1, hits: 2, repeats: 2, repeatHit: 1, unreadable: 0, duplicates: [] })
    expect(score).toMatchObject({ hits: 2, repeats: 2, repeatHit: 1 })
  })

  it('measures consistency as the share of photos on the majority row', () => {
    const score = scoreOrder(order([read('serum', 'r1', 'new-row'), read('serum', 'r1', 'exact-key'), read('serum', 'r1', 'exact-key'), read('serum', 'r2', 'new-row')]), NO_LABELS)

    expect(productOf(score, 'serum')).toMatchObject({ photos: 4, rows: 2, consistency: 0.75 })
  })

  it('measures repeat-hit against the row the first photo in this order resolved to, not the majority row', () => {
    // First photo lands on r1; the other three agree with each other on r2. Consistency is 0.75, but only one repeat hit r1... none do.
    const score = scoreOrder(order([read('serum', 'r1', 'new-row'), read('serum', 'r2', 'new-row'), read('serum', 'r2', 'exact-key'), read('serum', 'r2', 'exact-key')]), NO_LABELS)

    expect(productOf(score, 'serum')).toMatchObject({ consistency: 0.75, hits: 0, repeats: 3, repeatHit: 0 })
  })

  it('counts a repeat that lands back on the first row as a hit even after a stray photo', () => {
    const score = scoreOrder(order([read('serum', 'r1', 'new-row'), read('serum', 'r2', 'new-row'), read('serum', 'r1', 'exact-key')]), NO_LABELS)

    expect(productOf(score, 'serum')).toMatchObject({ hits: 1, repeats: 2, repeatHit: 0.5 })
  })

  it('keeps different products separate when their photos are interleaved', () => {
    const score = scoreOrder(order([read('serum', 'r1', 'new-row'), read('cream', 'r2', 'new-row'), read('serum', 'r1', 'exact-key'), read('cream', 'r2', 'judge-same')]), NO_LABELS)

    expect(productOf(score, 'serum')).toMatchObject({ photos: 2, repeatHit: 1 })
    expect(productOf(score, 'cream')).toMatchObject({ photos: 2, repeatHit: 1 })
    expect(score.products).toHaveLength(2)
  })

  it('pools repeats over every product for the order repeat-hit rate', () => {
    const score = scoreOrder(
      order([
        read('serum', 'r1', 'new-row'),
        read('serum', 'r1', 'exact-key'),
        read('serum', 'r1', 'exact-key'),
        read('cream', 'r2', 'new-row'),
        read('cream', 'r3', 'new-row'),
      ]),
      NO_LABELS,
    )

    // 2 hits of 3 repeats (serum 2/2, cream 0/1): pooled, not the mean of 1 and 0.
    expect(score).toMatchObject({ hits: 2, repeats: 3 })
    expect(score.repeatHit).toBeCloseTo(2 / 3, 10)
  })

  it('names a duplicate whose judge was asked about the product\'s row and said no as judge-said-no, and carries the differing field names', () => {
    const score = scoreOrder(
      order([
        read('serum', 'r1', 'new-row'),
        read('serum', 'r2', 'new-row', { judged: [{ candidateRowId: 'r1', same: false }], differs: ['variant', 'name'] }),
      ]),
      NO_LABELS,
    )

    const product = productOf(score, 'serum')
    expect(product.duplicates).toEqual([expect.objectContaining({ rowId: 'r2', cause: 'judge-said-no', differs: ['variant', 'name'] })])
    expect(score.duplicates).toBe(1)
  })

  it('names a duplicate the judge was never asked about as recognition-differed', () => {
    const score = scoreOrder(order([read('serum', 'r1', 'new-row'), read('serum', 'r2', 'new-row', { differs: ['brand'] })]), NO_LABELS)

    expect(productOf(score, 'serum').duplicates).toEqual([expect.objectContaining({ cause: 'recognition-differed', differs: ['brand'] })])
  })

  it('names a duplicate recognition-differed when the only no-answers were about another product\'s rows', () => {
    const score = scoreOrder(
      order([
        read('serum', 'r1', 'new-row'),
        read('cream', 'r2', 'new-row'),
        read('serum', 'r3', 'new-row', { judged: [{ candidateRowId: 'r2', same: false }] }),
      ]),
      NO_LABELS,
    )

    expect(productOf(score, 'serum').duplicates).toEqual([expect.objectContaining({ rowId: 'r3', cause: 'recognition-differed' })])
  })

  it('does not call a product\'s first row a duplicate, nor a repeat that joined an existing row', () => {
    const score = scoreOrder(order([read('serum', 'r1', 'new-row'), read('serum', 'r1', 'judge-same', { judged: [{ candidateRowId: 'r1', same: true }] })]), NO_LABELS)

    expect(score.duplicates).toBe(0)
  })

  it('lets the first readable photo define the row when the first photo is unreadable', () => {
    const score = scoreOrder(order([unreadable('serum'), read('serum', 'r1', 'new-row'), read('serum', 'r1', 'exact-key'), read('serum', 'r2', 'new-row')]), NO_LABELS)

    expect(productOf(score, 'serum')).toMatchObject({ photos: 4, unreadable: 1, hits: 1, repeats: 2, repeatHit: 0.5 })
    expect(productOf(score, 'serum').duplicates).toHaveLength(1)
    expect(score.unreadable).toBe(1)
  })

  it('scores a product whose every photo is unreadable with no repeat photos, without throwing', () => {
    const score = scoreOrder(order([unreadable('serum'), unreadable('serum'), read('cream', 'r1', 'new-row')]), NO_LABELS)

    expect(productOf(score, 'serum')).toMatchObject({ photos: 2, rows: 0, unreadable: 2, hits: 0, repeats: 0, duplicates: [] })
    expect(Number.isNaN(productOf(score, 'serum').repeatHit)).toBe(false)
    expect(Number.isNaN(productOf(score, 'serum').consistency)).toBe(false)
  })

  it('does not let an unreadable photo count as a miss', () => {
    const score = scoreOrder(order([read('serum', 'r1', 'new-row'), unreadable('serum'), read('serum', 'r1', 'exact-key')]), NO_LABELS)

    expect(productOf(score, 'serum')).toMatchObject({ hits: 1, repeats: 1, repeatHit: 1, unreadable: 1 })
  })

  it('flags a row holding photos of two products as a wrong merge that is not a declared look-alike', () => {
    const score = scoreOrder(order([read('serum', 'r1', 'new-row'), read('cream', 'r1', 'judge-same')]), NO_LABELS)

    expect(score.wrongMerges).toEqual([{ rowId: 'r1', folders: ['cream', 'serum'], lookalikes: false }])
  })

  it('flags a wrong merge between declared look-alikes as such, but still counts it', () => {
    const labels = { serum: { lookalikes: ['cream'] }, cream: { lookalikes: ['serum'] } }
    const score = scoreOrder(order([read('serum', 'r1', 'new-row'), read('cream', 'r1', 'judge-same')]), labels)

    expect(score.wrongMerges).toEqual([{ rowId: 'r1', folders: ['cream', 'serum'], lookalikes: true }])
  })

  it('reports no wrong merge when each row holds one product', () => {
    const score = scoreOrder(order([read('serum', 'r1', 'new-row'), read('cream', 'r2', 'new-row')]), NO_LABELS)

    expect(score.wrongMerges).toEqual([])
  })

  it('does not treat unreadable photos as sitting on any row', () => {
    const score = scoreOrder(order([read('serum', 'r1', 'new-row'), unreadable('cream')]), NO_LABELS)

    expect(score.wrongMerges).toEqual([])
  })

  it('keeps the seed on the order score', () => {
    expect(scoreOrder(order([], 42), NO_LABELS).seed).toBe(42)
  })
})

describe('scoreMatching', () => {
  // A product with one first photo and `repeats` repeats, `misses` of which land on a different row.
  const productOrder = (seed: number, repeats: number, misses: number) =>
    order(
      [
        read('serum', 'r1', 'new-row'),
        ...Array.from({ length: repeats - misses }, () => read('serum', 'r1', 'exact-key')),
        ...Array.from({ length: misses }, (_, i) => read('serum', `x${i}`, 'new-row')),
      ],
      seed,
    )

  it('reports the worst and the average repeat-hit rate across orders', () => {
    const score = scoreMatching([productOrder(1, 4, 0), productOrder(2, 4, 1), productOrder(3, 4, 2)], NO_LABELS)

    expect(score.worstRepeatHit).toBe(0.5)
    expect(score.averageRepeatHit).toBeCloseTo((1 + 0.75 + 0.5) / 3, 10)
    expect(score.orders.map((o) => o.seed)).toEqual([1, 2, 3])
  })

  it('counts wrong merges and duplicates over every order, so a merge in one order is not averaged away', () => {
    const merged = order([read('serum', 'r1', 'new-row'), read('cream', 'r1', 'judge-same')], 2)
    const clean = order([read('serum', 'r1', 'new-row'), read('cream', 'r2', 'new-row')], 1)
    const duplicated = order([read('serum', 'r1', 'new-row'), read('serum', 'r2', 'new-row')], 3)

    const score = scoreMatching([clean, merged, duplicated], NO_LABELS)

    expect(score.wrongMerges).toBe(1)
    expect(score.duplicates).toBe(1)
  })

  it('scores no orders as a vacuous pass with nothing wrong', () => {
    expect(scoreMatching([], NO_LABELS)).toMatchObject({ worstRepeatHit: 1, averageRepeatHit: 1, wrongMerges: 0, duplicates: 0 })
  })
})

describe('scoreImages', () => {
  const img = (folder: string, stage: ImageOutcome['stage'], hash?: string): ImageOutcome => ({ folder, stage, ...(hash ? { hash } : {}) })

  it('scores coverage as stored products over all products', () => {
    const score = scoreImages([img('a', 'stored', 'h1'), img('b', 'stored', 'h2'), img('c', 'no-page-image'), img('d', 'download-failed')], { h1: 'right', h2: 'right' })

    expect(score).toMatchObject({ products: 4, stored: 2, coverage: 0.5 })
  })

  it('counts products at each stage, with zero for stages nobody reached', () => {
    const score = scoreImages([img('a', 'no-page-image'), img('b', 'no-page-image'), img('c', 'not-this-product'), img('d', 'error')], {})

    expect(score.stages).toMatchObject({ 'no-page-image': 2, 'not-this-product': 1, error: 1, stored: 0, 'budget-exhausted': 0, 'no-source-page': 0, 'checked-recently': 0, 'already-has-image': 0, 'download-failed': 0 })
  })

  it('counts a stored image the owner marked wrong as wrong, right as right, and one with no verdict as unjudged', () => {
    const score = scoreImages([img('a', 'stored', 'h1'), img('b', 'stored', 'h2'), img('c', 'stored', 'h3')], { h1: 'right', h2: 'wrong' })

    expect(score).toMatchObject({ right: 1, wrong: 1, unjudged: 1, stored: 3 })
  })

  it('still counts an unjudged image toward coverage', () => {
    expect(scoreImages([img('a', 'stored', 'h1')], {})).toMatchObject({ coverage: 1, unjudged: 1 })
  })

  it('judges only stored images; a verdict for some other hash changes nothing', () => {
    const score = scoreImages([img('a', 'no-page-image')], { zzz: 'wrong' })

    expect(score).toMatchObject({ wrong: 0, right: 0, unjudged: 0 })
  })

  it('reports the verdict beside each product', () => {
    const score = scoreImages([img('a', 'stored', 'h1'), img('b', 'stored', 'h2'), img('c', 'error')], { h1: 'wrong' })

    expect(score.perProduct).toEqual([
      { folder: 'a', stage: 'stored', hash: 'h1', verdict: 'wrong' },
      { folder: 'b', stage: 'stored', hash: 'h2', verdict: 'unjudged' },
      { folder: 'c', stage: 'error' },
    ])
  })
})

describe('judge and exitCode', () => {
  // Builders that reach an exact repeat-hit / coverage by construction.
  const matchingWith = (repeats: number, misses: number, merged = false) => {
    const photos = [
      read('serum', 'r1', 'new-row'),
      ...Array.from({ length: repeats - misses }, () => read('serum', 'r1', 'exact-key')),
      ...Array.from({ length: misses }, (_, i) => read('serum', `x${i}`, 'new-row')),
      ...(merged ? [read('cream', 'r1', 'judge-same')] : []),
    ]
    return scoreMatching([order(photos)], NO_LABELS)
  }
  const imagesWith = (stored: number, total: number, hashVerdict: 'right' | 'wrong' = 'right') => {
    const outcomes: ImageOutcome[] = Array.from({ length: total }, (_, i) => (i < stored ? { folder: `p${i}`, stage: 'stored', hash: `h${i}` } : { folder: `p${i}`, stage: 'no-page-image' }))
    const verdicts = Object.fromEntries(outcomes.filter((o) => o.hash).map((o) => [o.hash!, hashVerdict]))
    return scoreImages(outcomes, verdicts)
  }
  const target = (v: ReturnType<typeof judge>, id: string) => v.targets.find((t) => t.id === id)

  it('meets the worst-order repeat-hit target at exactly 0.98', () => {
    const v = judge({ matching: matchingWith(50, 1) })

    expect(target(v, 'matching-repeat-hit')).toMatchObject({ met: true })
    expect(exitCode(v)).toBe(0)
  })

  it('misses the worst-order repeat-hit target just below 0.98', () => {
    const v = judge({ matching: matchingWith(49, 1) }) // 48/49 = 0.9796

    expect(target(v, 'matching-repeat-hit')).toMatchObject({ met: false })
    expect(exitCode(v)).toBe(1)
  })

  it('judges repeat-hit on the worst order, not the average', () => {
    const good = order([read('serum', 'r1', 'new-row'), ...Array.from({ length: 10 }, () => read('serum', 'r1', 'exact-key'))], 1)
    const bad = order([read('serum', 'r1', 'new-row'), read('serum', 'r2', 'new-row')], 2)
    const v = judge({ matching: scoreMatching([good, bad], NO_LABELS) })

    expect(target(v, 'matching-repeat-hit')).toMatchObject({ met: false })
  })

  it('misses the matching target on a single wrong merge even with perfect repeat-hit', () => {
    const v = judge({ matching: matchingWith(10, 0, true) })

    expect(target(v, 'matching-repeat-hit')).toMatchObject({ met: true })
    expect(target(v, 'matching-wrong-merges')).toMatchObject({ met: false })
    expect(exitCode(v)).toBe(1)
  })

  it('meets the image coverage target at exactly 0.80 and misses it just below', () => {
    expect(target(judge({ images: imagesWith(4, 5) }), 'images-coverage')).toMatchObject({ met: true })
    expect(target(judge({ images: imagesWith(3, 4) }), 'images-coverage')).toMatchObject({ met: false })
    expect(exitCode(judge({ images: imagesWith(3, 4) }))).toBe(1)
  })

  it('misses the images target on a single wrong image, however good the coverage', () => {
    const outcomes: ImageOutcome[] = [{ folder: 'a', stage: 'stored', hash: 'h1' }, { folder: 'b', stage: 'stored', hash: 'h2' }]
    const v = judge({ images: scoreImages(outcomes, { h1: 'right', h2: 'wrong' }) })

    expect(target(v, 'images-coverage')).toMatchObject({ met: true })
    expect(target(v, 'images-wrong')).toMatchObject({ met: false })
    expect(exitCode(v)).toBe(1)
  })

  it('exits 0 when every target of both parts is met', () => {
    const v = judge({ matching: matchingWith(10, 0), images: imagesWith(5, 5) })

    expect(v.targets.map((t) => t.id).sort()).toEqual(['images-coverage', 'images-wrong', 'matching-repeat-hit', 'matching-wrong-merges'])
    expect(v.targets.every((t) => t.met)).toBe(true)
    expect(exitCode(v)).toBe(0)
  })

  it('exits 1 when matching passes but images miss', () => {
    expect(exitCode(judge({ matching: matchingWith(10, 0), images: imagesWith(1, 5) }))).toBe(1)
  })

  it('exits 1 when images pass but matching misses', () => {
    expect(exitCode(judge({ matching: matchingWith(10, 5), images: imagesWith(5, 5) }))).toBe(1)
  })

  it('does not judge a part that was not run: images alone say nothing about matching', () => {
    const v = judge({ images: imagesWith(5, 5) })

    expect(v.targets.map((t) => t.id).sort()).toEqual(['images-coverage', 'images-wrong'])
  })

  it('does not judge matching targets when only the images part ran, even if images fail', () => {
    const v = judge({ images: imagesWith(0, 5) })

    expect(v.targets.some((t) => t.id.startsWith('matching-'))).toBe(false)
  })

  it('says the verdict is provisional with the count of unjudged images, and still exits 0 when targets are met', () => {
    const images = scoreImages([{ folder: 'a', stage: 'stored', hash: 'h1' }, { folder: 'b', stage: 'stored', hash: 'h2' }, { folder: 'c', stage: 'stored', hash: 'h3' }], { h1: 'right' })
    const v = judge({ images })

    expect(v.provisional).toBe(2)
    expect(v.summary).toContain('provisional: 2 images unjudged')
    expect(exitCode(v)).toBe(0)
  })

  it('does not say provisional when every stored image has a verdict, or when images did not run', () => {
    expect(judge({ images: imagesWith(5, 5) }).summary).not.toContain('provisional')
    expect(judge({ matching: matchingWith(10, 0) }).provisional).toBe(0)
  })
})

describe('duplicateCost', () => {
  it('prices a duplicate as one research plus one analysis from a documented positive constant', () => {
    expect(DUPLICATE_COST_USD).toBeGreaterThan(0)
    expect(duplicateCost(0)).toBe(0)
    expect(duplicateCost(1)).toBe(DUPLICATE_COST_USD)
  })

  it('scales with the number of duplicates', () => {
    expect(duplicateCost(6)).toBeCloseTo(3 * duplicateCost(2), 10)
  })
})

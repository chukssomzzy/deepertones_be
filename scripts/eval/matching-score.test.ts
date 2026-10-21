import { describe, expect, it } from 'vitest'
import {
  DUPLICATE_COST_USD,
  ANALYSIS_COST_USD,
  duplicateCost,
  duplicateUnitCost,
  exitCode,
  judge,
  scoreImages,
  scoreMatching,
  scoreOrder,
  scoreShelf,
  type ImageOutcome,
  type ShelfPhotoInput,
  type PhotoOutcome,
} from './matching-score'

// Photo outcomes are listed in the order the photos were processed. A row id is just an opaque label for "the catalog row this photo landed on".

let photoCounter = 0
const photoName = (folder: string): string => `${folder}-${++photoCounter}.jpg`

const read = (folder: string, rowId: string, how: 'exact-key' | 'judge-same' | 'new-row', extra: Partial<Extract<PhotoOutcome, { rowId: string }>> = {}): PhotoOutcome => ({
  folder,
  photo: photoName(folder),
  rowId,
  how,
  judged: [],
  differs: [],
  ...extra,
})
const unreadable = (folder: string): PhotoOutcome => ({ folder, photo: photoName(folder), unreadable: true })
const errored = (folder: string, error = 'AnthropicUnavailableError'): PhotoOutcome => ({ folder, photo: photoName(folder), error })

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

  it('counts an errored photo apart from unreadable, and does not let it count as a miss or sit on a row', () => {
    const score = scoreOrder(order([read('serum', 'r1', 'new-row'), errored('serum'), read('serum', 'r1', 'exact-key'), unreadable('serum')]), NO_LABELS)

    expect(productOf(score, 'serum')).toMatchObject({ photos: 4, unreadable: 1, errors: 1, hits: 1, repeats: 1, repeatHit: 1 })
    expect(score).toMatchObject({ unreadable: 1, errors: 1 })
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

  it('scores no orders as having no evidence, not as a pass', () => {
    expect(scoreMatching([], NO_LABELS)).toMatchObject({ wrongMerges: 0, duplicates: 0, errors: 0, evidence: false })
    expect(exitCode(judge({ matching: scoreMatching([], NO_LABELS) }))).toBe(1)
  })

  it('has evidence only when every order has a product with at least two readable photos', () => {
    const repeated = order([read('serum', 'r1', 'new-row'), read('serum', 'r1', 'exact-key')], 1)
    const single = order([read('serum', 'r1', 'new-row'), unreadable('serum')], 2)

    expect(scoreMatching([repeated], NO_LABELS).evidence).toBe(true)
    expect(scoreMatching([repeated, single], NO_LABELS).evidence).toBe(false)
  })

  it('counts errors over every order and lists the distinct error names', () => {
    const a = order([read('serum', 'r1', 'new-row'), read('serum', 'r1', 'exact-key'), errored('serum', 'AnthropicRequestError')], 1)
    const b = order([read('serum', 'r1', 'new-row'), read('serum', 'r1', 'exact-key'), errored('serum', 'AnthropicRequestError'), errored('cream', 'AnthropicRefusalError')], 2)

    const score = scoreMatching([a, b], NO_LABELS)

    expect(score.errors).toBe(3)
    expect(score.errorNames).toEqual(['AnthropicRefusalError', 'AnthropicRequestError'])
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

  it('carries the error name of a product whose image stage errored, and lists the names', () => {
    const score = scoreImages([{ folder: 'a', stage: 'error', error: 'AnthropicUnavailableError' }, { folder: 'b', stage: 'error', error: 'AnthropicUnavailableError' }, img('c', 'stored', 'h1')], {})

    expect(score.perProduct[0]).toEqual({ folder: 'a', stage: 'error', error: 'AnthropicUnavailableError' })
    expect(score.errorNames).toEqual(['AnthropicUnavailableError'])
    expect(score.stages.error).toBe(2)
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

    expect(v.targets.map((t) => t.id).sort()).toEqual(['images-coverage', 'images-evidence', 'images-wrong', 'matching-errors', 'matching-evidence', 'matching-repeat-hit', 'matching-wrong-merges'])
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

    expect(v.targets.map((t) => t.id).sort()).toEqual(['images-coverage', 'images-evidence', 'images-wrong'])
  })

  it('does not judge matching targets when only the images part ran, even if images fail', () => {
    const v = judge({ images: imagesWith(0, 5) })

    expect(v.targets.some((t) => t.id.startsWith('matching-'))).toBe(false)
  })

  it('fails the run when any matching photo errored, naming the count, even with perfect repeat-hit', () => {
    const photos = [read('serum', 'r1', 'new-row'), read('serum', 'r1', 'exact-key'), errored('cream'), errored('cream')]
    const v = judge({ matching: scoreMatching([order(photos)], NO_LABELS) })

    expect(target(v, 'matching-repeat-hit')).toMatchObject({ met: true })
    expect(target(v, 'matching-errors')).toMatchObject({ met: false })
    expect(v.summary).toContain('matching-errors: 2 photos errored (see report)')
    expect(exitCode(v)).toBe(1)
  })

  it('does not fail on unreadable photos alone', () => {
    const photos = [read('serum', 'r1', 'new-row'), read('serum', 'r1', 'exact-key'), unreadable('cream')]
    const v = judge({ matching: scoreMatching([order(photos)], NO_LABELS) })

    expect(target(v, 'matching-errors')).toMatchObject({ met: true })
    expect(exitCode(v)).toBe(0)
  })

  it('does not meet the matching targets when no order has a repeat to measure, and says why', () => {
    const photos = [read('serum', 'r1', 'new-row'), read('cream', 'r2', 'new-row')]
    const v = judge({ matching: scoreMatching([order(photos)], NO_LABELS) })

    expect(target(v, 'matching-evidence')).toMatchObject({ met: false })
    expect(v.summary).toContain('no evidence')
    expect(exitCode(v)).toBe(1)
  })

  it('does not meet the images targets when there were no products, and says why', () => {
    const v = judge({ images: scoreImages([], {}) })

    expect(target(v, 'images-evidence')).toMatchObject({ met: false })
    expect(v.summary).toContain('no evidence')
    expect(exitCode(v)).toBe(1)
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

  it('prices each duplicate at a given unit cost when one is supplied', () => {
    expect(duplicateCost(3, 0.5)).toBeCloseTo(1.5, 10)
  })

  it('scales with the number of duplicates', () => {
    expect(duplicateCost(6)).toBeCloseTo(3 * duplicateCost(2), 10)
  })
})

describe('duplicateUnitCost', () => {
  const entry = (job: string, status: 'settled' | 'reserved' | 'released', costMicros: number | null) => ({ job, status, costMicros })

  it('falls back to the documented constant when no research was settled', () => {
    expect(duplicateUnitCost([])).toEqual({ each: DUPLICATE_COST_USD, source: 'constant' })
    expect(duplicateUnitCost([entry('research', 'released', null), entry('research', 'reserved', null), entry('image-check', 'settled', 9_000_000)])).toEqual({ each: DUPLICATE_COST_USD, source: 'constant' })
  })

  it('uses the mean settled research cost plus the analysis constant, since analysis never runs here', () => {
    const { each, source } = duplicateUnitCost([entry('research', 'settled', 40_000), entry('research', 'settled', 60_000), entry('same-product', 'settled', 1_000_000), entry('research', 'released', null)])

    expect(source).toBe('measured')
    expect(each).toBeCloseTo(0.05 + ANALYSIS_COST_USD, 10)
  })
})

// scoreShelf takes one ShelfPhotoInput per shelf photo, in run order:
//   { photo, labelled: [{ id, rowId, brand, inSet }] in label order, listed: [{ brand, landed }] in listed order, error? }
// `rowId` is the row the labelled product was seeded as; `landed` is the row a listed product resolved to, or null when resolve created a row.
describe('scoreShelf', () => {
  const lab = (id: string, brand = 'Acme', inSet = true) => ({ id, rowId: `row-${id}`, brand, inSet })
  const onRow = (id: string, brand = 'Acme') => ({ brand, landed: `row-${id}` })
  const created = (brand = 'Acme') => ({ brand, landed: null })
  const shelf = (photo: string, labelled: ShelfPhotoInput['labelled'], listed: ShelfPhotoInput['listed'], error?: string): ShelfPhotoInput => ({ photo, labelled, listed, ...(error ? { error } : {}) })
  const first = (score: ReturnType<typeof scoreShelf>) => score.photos[0]!

  it('counts a listed product that landed on a labelled product\'s row as found, and a labelled product nobody listed as missing', () => {
    const score = scoreShelf([shelf('a.jpg', [lab('p1'), lab('p2')], [onRow('p1')])])

    expect(first(score)).toMatchObject({ photo: 'a.jpg', labelled: 2, expected: 2, found: 1, repeat: 0, misread: 0, invented: 0, wrongRows: 0, missing: ['p2'] })
    expect(first(score).outcomes).toEqual(['found'])
  })

  it('counts a product listed twice as found once and a repeat once', () => {
    const score = scoreShelf([shelf('a.jpg', [lab('p1')], [onRow('p1'), onRow('p1')])])

    expect(first(score)).toMatchObject({ found: 1, repeat: 1, misread: 0, invented: 0, wrongRows: 0, missing: [] })
    expect(first(score).outcomes).toEqual(['found', 'repeat'])
  })

  it('counts a listed product that landed on a row of a product not in the photo as a wrong row', () => {
    const score = scoreShelf([shelf('a.jpg', [lab('p1')], [{ brand: 'Acme', landed: 'row-elsewhere' }])])

    expect(first(score)).toMatchObject({ found: 0, wrongRows: 1, misread: 0, invented: 0, missing: ['p1'] })
    expect(first(score).outcomes).toEqual(['wrong-row'])
  })

  it('calls a created row misread when a labelled product of the same brand family is still unfound', () => {
    const score = scoreShelf([shelf('a.jpg', [lab('p1', 'CeraVe')], [created('Cerave Paris')])])

    expect(first(score)).toMatchObject({ found: 0, misread: 1, invented: 0 })
    expect(first(score).outcomes).toEqual(['misread'])
  })

  it('calls a created row invented when no labelled product shares its brand family', () => {
    const score = scoreShelf([shelf('a.jpg', [lab('p1', 'CeraVe')], [created('Nivea')])])

    expect(first(score)).toMatchObject({ misread: 0, invented: 1 })
    expect(first(score).outcomes).toEqual(['invented'])
  })

  it('calls a created row invented when every labelled product of its brand family is already found', () => {
    const score = scoreShelf([shelf('a.jpg', [lab('p1')], [onRow('p1'), created()])])

    expect(first(score)).toMatchObject({ found: 1, misread: 0, invented: 1 })
    expect(first(score).outcomes).toEqual(['found', 'invented'])
  })

  it('attributes each misread to the next unfound same-brand product in label order, so two created rows are two misreads and a third is invented', () => {
    const score = scoreShelf([shelf('a.jpg', [lab('p1'), lab('p2')], [created(), created(), created()])])

    expect(first(score)).toMatchObject({ misread: 2, invented: 1, missing: ['p1', 'p2'] })
    expect(first(score).outcomes).toEqual(['misread', 'misread', 'invented'])
  })

  it('does not attribute a misread to a product found later in the listing order', () => {
    // p1 is found by the second listed product, so the first created row (listed before) is a misread of p1 only if p1 is still unfound then.
    const score = scoreShelf([shelf('a.jpg', [lab('p1'), lab('p2')], [created(), onRow('p1')])])

    expect(first(score).outcomes).toEqual(['misread', 'found'])
    expect(first(score)).toMatchObject({ found: 1, misread: 1, missing: ['p2'] })
  })

  it('expects at most 5 products per photo, so finding 5 of 7 labelled is a found rate of 1', () => {
    const labelled = Array.from({ length: 7 }, (_, i) => lab(`p${i}`))
    const score = scoreShelf([shelf('a.jpg', labelled, labelled.slice(0, 5).map((l) => onRow(l.id)))])

    expect(first(score)).toMatchObject({ labelled: 7, expected: 5, found: 5 })
    expect(score).toMatchObject({ labelled: 7, expected: 5, found: 5, foundRate: 1 })
  })

  it('expects every labelled product when a photo has 5 or fewer', () => {
    const score = scoreShelf([shelf('a.jpg', [lab('p1'), lab('p2'), lab('p3'), lab('p4'), lab('p5')], [onRow('p1')])])

    expect(first(score)).toMatchObject({ labelled: 5, expected: 5 })
  })

  it('sums found over the sum of expected across photos, not the mean of per-photo rates', () => {
    // Photo A finds 1 of 1; photo B finds 1 of 4. Pooled 2/5 = 0.4 (the mean of rates would be 0.625).
    const score = scoreShelf([
      shelf('a.jpg', [lab('a1')], [onRow('a1')]),
      shelf('b.jpg', [lab('b1'), lab('b2'), lab('b3'), lab('b4')], [onRow('b1')]),
    ])

    expect(score).toMatchObject({ labelled: 5, expected: 5, found: 2 })
    expect(score.foundRate).toBeCloseTo(0.4, 10)
    expect(score.photos.map((p) => p.found)).toEqual([1, 1])
  })

  it('totals repeat, misread, invented and wrong rows across photos', () => {
    const score = scoreShelf([
      shelf('a.jpg', [lab('a1')], [onRow('a1'), onRow('a1'), created('Zed')]),
      shelf('b.jpg', [lab('b1')], [created(), { brand: 'Acme', landed: 'row-elsewhere' }]),
    ])

    expect(score).toMatchObject({ found: 1, repeat: 1, invented: 1, misread: 1, wrongRows: 1 })
  })

  it('measures same-row as found in-set over found in-set plus misread in-set', () => {
    // In-set: p1 found, p2 misread -> 1/2. Out-of-set p3 found and p4 misread are not in this rate.
    const score = scoreShelf([shelf('a.jpg', [lab('p1', 'Acme'), lab('p2', 'Acme'), lab('p3', 'Out', false), lab('p4', 'Other', false)], [onRow('p1'), created('Acme'), onRow('p3', 'Out'), created('Other')])])

    expect(score).toMatchObject({ found: 2, misread: 2 })
    expect(score.sameRow).toBeCloseTo(0.5, 10)
  })

  it('does not count a misread of an out-of-set product against same-row', () => {
    const score = scoreShelf([shelf('a.jpg', [lab('p1', 'Acme'), lab('p2', 'Out', false)], [onRow('p1'), created('Out')])])

    expect(score.sameRow).toBe(1)
    expect(score.misread).toBe(1)
  })

  it('does not count a wrong row in same-row: its landed row is not a product of the photo, so it cannot be attributed', () => {
    const score = scoreShelf([shelf('a.jpg', [lab('p1')], [onRow('p1'), { brand: 'Acme', landed: 'row-elsewhere' }])])

    expect(score).toMatchObject({ found: 1, wrongRows: 1 })
    expect(score.sameRow).toBe(1)
  })

  it('does not count a repeat or an invented product in same-row', () => {
    const score = scoreShelf([shelf('a.jpg', [lab('p1')], [onRow('p1'), onRow('p1'), created('Zed')])])

    expect(score.sameRow).toBe(1)
  })

  it('reports same-row across photos as one pooled share', () => {
    const score = scoreShelf([
      shelf('a.jpg', [lab('a1'), lab('a2'), lab('a3')], [onRow('a1'), onRow('a2'), onRow('a3')]),
      shelf('b.jpg', [lab('b1')], [created()]),
    ])

    expect(score.sameRow).toBeCloseTo(3 / 4, 10)
  })

  it('records a photo whose recognition errored with its error name, and counts it in errors and errorNames', () => {
    const score = scoreShelf([
      shelf('a.jpg', [lab('p1')], [onRow('p1')]),
      shelf('b.jpg', [lab('b1')], [], 'AnthropicUnavailableError'),
      shelf('c.jpg', [lab('c1')], [], 'AnthropicUnavailableError'),
      shelf('d.jpg', [lab('d1')], [], 'AnthropicRefusalError'),
    ])

    expect(score.errors).toBe(3)
    expect(score.errorNames).toEqual(['AnthropicRefusalError', 'AnthropicUnavailableError'])
    expect(score.photos[1]).toMatchObject({ photo: 'b.jpg', error: 'AnthropicUnavailableError' })
    expect(score.photos[0]!.error).toBeUndefined()
    expect(score.evidence).toBe(true)
  })

  it('has no evidence with no photos, or when every photo errored', () => {
    expect(scoreShelf([]).evidence).toBe(false)
    expect(scoreShelf([shelf('a.jpg', [lab('p1')], [], 'AnthropicUnavailableError')]).evidence).toBe(false)
  })

  it('has evidence once one photo was read, even if it listed nothing', () => {
    expect(scoreShelf([shelf('a.jpg', [lab('p1')], [])]).evidence).toBe(true)
  })
})

describe('judge with shelf', () => {
  // 4 photos of 5 in-set Acme products: 20 expected. `found` of them are listed on their rows, `misread` more are created rows.
  const shelfWith = (found: number, extra: { misread?: number; invented?: number; wrong?: number; error?: string } = {}) => {
    const photos: ShelfPhotoInput[] = Array.from({ length: 4 }, (_, p) => ({
      photo: `p${p}.jpg`,
      labelled: Array.from({ length: 5 }, (_, i) => ({ id: `p${p}-${i}`, rowId: `row-p${p}-${i}`, brand: 'Acme', inSet: true })),
      listed: [],
    }))
    let index = 0
    const at = () => photos[Math.floor(index / 5)]!
    for (; index < found; index++) at().listed.push({ brand: 'Acme', landed: `row-${at().labelled[index % 5]!.id}` })
    for (let m = 0; m < (extra.misread ?? 0); m++, index++) at().listed.push({ brand: 'Acme', landed: null })
    for (let i = 0; i < (extra.invented ?? 0); i++) photos[0]!.listed.push({ brand: 'Zed', landed: null })
    for (let w = 0; w < (extra.wrong ?? 0); w++) photos[0]!.listed.push({ brand: 'Acme', landed: 'row-elsewhere' })
    if (extra.error) photos[3]!.error = extra.error
    return scoreShelf(photos)
  }
  const target = (v: ReturnType<typeof judge>, id: string) => v.targets.find((t) => t.id === id)

  it('meets every shelf target for a clean shelf run and exits 0', () => {
    const v = judge({ shelf: shelfWith(20) })

    expect(v.targets.map((t) => t.id).sort()).toEqual(['shelf-errors', 'shelf-evidence', 'shelf-found', 'shelf-invented', 'shelf-same-row', 'shelf-wrong-merges'])
    expect(v.targets.every((t) => t.met)).toBe(true)
    expect(exitCode(v)).toBe(0)
  })

  it('meets shelf-found at exactly 90% and misses it just below', () => {
    expect(target(judge({ shelf: shelfWith(18, { misread: 2 }) }), 'shelf-found')).toMatchObject({ met: true })
    expect(target(judge({ shelf: shelfWith(17, { misread: 3 }) }), 'shelf-found')).toMatchObject({ met: false })
  })

  it('meets shelf-same-row at exactly 95% and misses it just below', () => {
    // 19 found + 1 misread = 19/20 = 95%.
    expect(target(judge({ shelf: shelfWith(19, { misread: 1 }) }), 'shelf-same-row')).toMatchObject({ met: true })
    // 18 found + 2 misread = 90%: same-row misses while found (90%) is still met.
    const v = judge({ shelf: shelfWith(18, { misread: 2 }) })
    expect(target(v, 'shelf-same-row')).toMatchObject({ met: false })
    expect(target(v, 'shelf-found')).toMatchObject({ met: true })
    expect(exitCode(v)).toBe(1)
  })

  it('misses shelf-invented at one invented product and meets it at none', () => {
    expect(target(judge({ shelf: shelfWith(20) }), 'shelf-invented')).toMatchObject({ met: true })
    const v = judge({ shelf: shelfWith(20, { invented: 1 }) })
    expect(target(v, 'shelf-invented')).toMatchObject({ met: false })
    expect(exitCode(v)).toBe(1)
  })

  it('misses shelf-wrong-merges at one wrong row and meets it at none', () => {
    expect(target(judge({ shelf: shelfWith(20) }), 'shelf-wrong-merges')).toMatchObject({ met: true })
    const v = judge({ shelf: shelfWith(20, { wrong: 1 }) })
    expect(target(v, 'shelf-wrong-merges')).toMatchObject({ met: false })
    expect(exitCode(v)).toBe(1)
  })

  it('misses shelf-errors when a photo errored and meets it when none did', () => {
    expect(target(judge({ shelf: shelfWith(20) }), 'shelf-errors')).toMatchObject({ met: true })
    const v = judge({ shelf: shelfWith(15, { error: 'AnthropicUnavailableError' }) })
    expect(target(v, 'shelf-errors')).toMatchObject({ met: false })
    expect(exitCode(v)).toBe(1)
  })

  it('misses shelf-evidence, and so exits 1, when there are no shelf photos', () => {
    const v = judge({ shelf: scoreShelf([]) })

    expect(target(v, 'shelf-evidence')).toMatchObject({ met: false })
    expect(exitCode(v)).toBe(1)
  })

  it('has no shelf targets when the shelf part did not run', () => {
    const v = judge({ images: scoreImages([{ folder: 'a', stage: 'stored', hash: 'h' }], { h: 'right' }) })

    expect(v.targets.some((t) => t.id.startsWith('shelf-'))).toBe(false)
  })

  it('keeps the matching and images targets as they were when shelf is added alongside', () => {
    const matching = scoreMatching([order([read('serum', 'r1', 'new-row'), read('serum', 'r1', 'exact-key')])], NO_LABELS)
    const without = judge({ matching })
    const withShelf = judge({ matching, shelf: shelfWith(20) })

    expect(withShelf.targets.filter((t) => !t.id.startsWith('shelf-'))).toEqual(without.targets)
  })
})

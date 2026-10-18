export type ShelfEntry = { brand: string; name: string }

export type ShelfScore = {
  expected: number
  found: number
  matched: number
  /** Matched over expected; 1 when nothing was expected. */
  recall: number
  /** Matched over found; 1 when nothing was found. */
  precision: number
  /** Expected products no found product matched. */
  missing: ShelfEntry[]
  /** Found products that matched no expected product. */
  extra: ShelfEntry[]
}

export type ShelfSummary = Omit<ShelfScore, 'missing' | 'extra'> & { photos: number }

const normalise = (entry: ShelfEntry): string => `${entry.brand.trim().replace(/\s+/g, ' ').toLowerCase()}\u0000${entry.name.trim().replace(/\s+/g, ' ').toLowerCase()}`

const ratio = (part: number, whole: number): number => (whole === 0 ? 1 : part / whole)

/** Brand and name must both match, ignoring case and runs of spaces. Each expected product is matched by at most one found product. */
export const scoreShelf = (expected: ShelfEntry[], found: ShelfEntry[]): ShelfScore => {
  const unmatched = expected.map((entry) => ({ entry, key: normalise(entry) }))
  const extra: ShelfEntry[] = []
  for (const entry of found) {
    const at = unmatched.findIndex((candidate) => candidate.key === normalise(entry))
    if (at === -1) extra.push(entry)
    else unmatched.splice(at, 1)
  }
  const matched = found.length - extra.length
  return {
    expected: expected.length,
    found: found.length,
    matched,
    recall: ratio(matched, expected.length),
    precision: ratio(matched, found.length),
    missing: unmatched.map((candidate) => candidate.entry),
    extra,
  }
}

/** Micro-averaged: totals over every photo, so a big shelf counts for more than a small one. */
export const summariseShelf = (scores: ShelfScore[]): ShelfSummary => {
  const expected = scores.reduce((sum, s) => sum + s.expected, 0)
  const found = scores.reduce((sum, s) => sum + s.found, 0)
  const matched = scores.reduce((sum, s) => sum + s.matched, 0)
  return { photos: scores.length, expected, found, matched, recall: ratio(matched, expected), precision: ratio(matched, found) }
}

import { describe, expect, it } from 'vitest'
import type { SafetyMentionRow } from '../safety/safety.types'
import { verdictFingerprint } from './verdicts.fingerprint'

// The fingerprint of a verdict (spec #171, "Decisions after the fact check" and "Decisions for the endpoint"): a hash of exactly what a saved verdict was built
// from, so that a change to any input makes the saved verdict stale (the next read rebuilds it) and no change leaves it alone, which is what keeps the model from
// being billed twice for the same shelf. sha256Hex(stableJson(...)).
//
// Shapes assumed (the contract this file pins). The input is plain data the endpoint's service already holds:
//   shelf   the profile's active entries, ANY category, each { id, kind, category, brand, name, variant } plus { formulationId } for a product and
//           { noLabelPurpose } for a no-label entry. Non-skin entries are left out of the hash.
//   rules   the live rules as the floor reads them, each with its group, clashesWith and helps
//   safety  what SafetyService.snapshotFor gives: { view, parseState, mentions }, hashed by CONTENT (no row ids, no times)
//   scan    what FaceScanService.latestConcernLevelsFor gives, or null
// The global catalog version is NOT an input: a Products-only upload must not re-bill verdicts.

type Input = Parameters<typeof verdictFingerprint>[0]
type Shelf = Input['shelf']
type Rules = Input['rules']

const AT = new Date('2030-06-15T12:00:00.000Z')
const LATER = new Date(AT.getTime() + 60 * 1000)

const mention = (over: Partial<SafetyMentionRow> = {}): SafetyMentionRow => ({
  id: 'mention-1',
  safetyId: 'safety-1',
  source: 'reaction',
  kind: 'product',
  brand: 'Orbis',
  name: 'Night Cream',
  variant: null,
  category: 'skin',
  productId: 'prod-night',
  resolution: 'resolved',
  position: 0,
  createdAt: AT,
  ...over,
})

const BASE: Input = {
  rulesVersion: 'rules-0123456789abcdef',
  rules: [
    { name: 'retinol', aliases: ['vitamin a'], kind: 'pregnancy-caution', rule: 'Avoid in pregnancy.', source: null, group: 'retinoid', clashesWith: ['exfoliating-acid'], helps: ['hd_age_spot'] },
    { name: 'glycolic acid', aliases: [], kind: 'irritation', rule: 'Can sting.', source: null, group: 'exfoliating-acid', clashesWith: ['retinoid'], helps: ['hd_texture'] },
  ],
  claimPhrases: ['whitening', 'bleaching'],
  tapers: { steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' },
  goal: 'fade-dark-marks',
  shelf: [
    { id: 'entry-a', kind: 'product', category: 'skin', brand: 'Orbis', name: 'Night Serum', variant: null, formulationId: 'form-a' },
    { id: 'entry-b', kind: 'product', category: 'skin', brand: 'Orbis', name: 'Day Cream', variant: 'spf 30', formulationId: 'form-b' },
    { id: 'entry-c', kind: 'no-label', category: 'skin', brand: null, name: 'Market tub', variant: null, noLabelPurpose: 'moisturise' },
  ],
  safety: {
    view: { choices: ['reaction', 'prescription'], reactionText: 'Night Cream', prescriptionText: 'Dermovate', excludesPregnancyCaution: false, updatedAt: AT },
    parseState: 'done',
    mentions: [mention(), mention({ id: 'mention-2', source: 'prescription', name: 'Dermovate', productId: 'prod-derm', position: 1 })],
  },
  scan: { skinType: 'combination', concerns: [{ concern: 'hd_age_spot', band: 'some' }, { concern: 'hd_redness', band: 'a-little' }] },
  model: 'claude-sonnet-5-5',
  promptHash: 'prompt-hash-1',
}

const hashOf = (input: Input) => verdictFingerprint(input)
const withShelf = (shelf: Shelf): Input => ({ ...BASE, shelf })
const withRules = (rules: Rules): Input => ({ ...BASE, rules })
const withSafety = (over: Partial<Input['safety']>): Input => ({ ...BASE, safety: { ...BASE.safety, ...over } })
const withView = (over: Partial<NonNullable<Input['safety']['view']>>): Input => withSafety({ view: { ...BASE.safety.view!, ...over } })
const changeShelfEntry = (id: string, over: Record<string, unknown>): Input => withShelf(BASE.shelf.map((entry) => (entry.id === id ? ({ ...entry, ...over } as Shelf[number]) : entry)))

describe('verdictFingerprint: what stays the same', () => {
  it('is a 64-character hex hash', async () => {
    expect(await hashOf(BASE)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is the same for the same inputs, however the objects were built', async () => {
    expect(await hashOf(structuredClone(BASE))).toBe(await hashOf(BASE))
  })

  it('is the same whatever order the shelf entries come in', async () => {
    expect(await hashOf(withShelf([...BASE.shelf].reverse()))).toBe(await hashOf(BASE))
    expect(await hashOf(withShelf([BASE.shelf[1]!, BASE.shelf[2]!, BASE.shelf[0]!]))).toBe(await hashOf(BASE))
  })

  it('is the same whatever order the rules come in', async () => {
    expect(await hashOf(withRules([...BASE.rules].reverse()))).toBe(await hashOf(BASE))
  })

  // Two rules can share a name (retinol is both an irritant and a pregnancy caution), so the name alone cannot order them.
  describe('two rules that share a name', () => {
    const SAME_NAME: [string, Rules[number]][] = [
      ['another kind', { ...BASE.rules[0]!, kind: 'irritation', rule: 'Can sting.', group: null, clashesWith: [], helps: [] }],
      ['the same kind and another statement', { ...BASE.rules[0]!, rule: 'Avoid in the first trimester.' }],
    ]

    it.each(SAME_NAME)('hash the same in either order when they differ by %s', async (_name, twin) => {
      const [retinol, glycolic] = BASE.rules as [Rules[number], Rules[number]]

      expect(await hashOf(withRules([retinol, twin, glycolic]))).toBe(await hashOf(withRules([twin, retinol, glycolic])))
      expect(await hashOf(withRules([glycolic, twin, retinol]))).toBe(await hashOf(withRules([retinol, glycolic, twin])))
    })

    it('are two rules and not one: adding the twin changes the hash', async () => {
      const [retinol, glycolic] = BASE.rules as [Rules[number], Rules[number]]
      const twin: Rules[number] = { ...retinol, kind: 'irritation', rule: 'Can sting.', group: null, clashesWith: [], helps: [] }

      expect(await hashOf(withRules([retinol, twin, glycolic]))).not.toBe(await hashOf(BASE))
    })
  })

  it('is the same whatever order the aliases, the clashes and the helped concerns of a rule come in', async () => {
    const [retinol, glycolic] = BASE.rules as [Rules[number], Rules[number]]
    const wide: Rules[number] = { ...retinol, aliases: ['vitamin a', 'retinyl'], clashesWith: ['exfoliating-acid', 'benzoyl-peroxide'], helps: ['hd_age_spot', 'hd_texture'] }
    const shuffled: Rules[number] = { ...wide, aliases: ['retinyl', 'vitamin a'], clashesWith: ['benzoyl-peroxide', 'exfoliating-acid'], helps: ['hd_texture', 'hd_age_spot'] }

    expect(await hashOf(withRules([shuffled, glycolic]))).toBe(await hashOf(withRules([wide, glycolic])))
  })

  it('is the same whatever order the safety mentions come in', async () => {
    const [first, second] = BASE.safety.mentions as [SafetyMentionRow, SafetyMentionRow]
    const third = mention({ id: 'mention-3', kind: 'ingredient', name: 'fragrance', brand: null, category: null, productId: null, resolution: null, position: 2 })

    expect(await hashOf(withSafety({ mentions: [third, second, first] }))).toBe(await hashOf(withSafety({ mentions: [first, second, third] })))
  })

  it('is the same for a re-save of identical safety answers: a new row, a later time, new mention ids, the choices in another order', async () => {
    const resaved = withSafety({
      view: { ...BASE.safety.view!, choices: ['prescription', 'reaction'], updatedAt: LATER },
      mentions: [
        mention({ id: 'mention-9', safetyId: 'safety-2', createdAt: LATER }),
        mention({ id: 'mention-10', safetyId: 'safety-2', source: 'prescription', name: 'Dermovate', productId: 'prod-derm', position: 1, createdAt: LATER }),
      ],
    })

    expect(await hashOf(resaved)).toBe(await hashOf(BASE))
  })

  it('is not changed by the global catalog version, which is not an input: a Products-only upload leaves a verdict current', async () => {
    const withCatalogVersion = { ...BASE, catalogVersion: 99 } as Input

    expect(await hashOf(withCatalogVersion)).toBe(await hashOf(BASE))
  })

  it('is not changed by a shelf item that is not skin (hair, body or makeup), added or taken away', async () => {
    const hair = { id: 'entry-h', kind: 'product', category: 'hair', brand: 'Orbis', name: 'Shampoo', variant: null, formulationId: 'form-h' } as Shelf[number]
    const makeup = { id: 'entry-m', kind: 'no-label', category: 'makeup', brand: null, name: 'Lipstick', variant: null, noLabelPurpose: 'not-sure' } as Shelf[number]

    expect(await hashOf(withShelf([...BASE.shelf, hair, makeup]))).toBe(await hashOf(BASE))
  })
})

describe('verdictFingerprint: what changes it', () => {
  const CHANGES: [string, () => Input][] = [
    // the shelf
    ['a product added to the shelf', () => withShelf([...BASE.shelf, { id: 'entry-d', kind: 'product', category: 'skin', brand: 'Orbis', name: 'Toner', variant: null, formulationId: 'form-d' } as Shelf[number]])],
    ['a product taken off the shelf', () => withShelf(BASE.shelf.filter((entry) => entry.id !== 'entry-b'))],
    ['an entry with another id', () => changeShelfEntry('entry-a', { id: 'entry-z' })],
    ['a product with another formulation', () => changeShelfEntry('entry-a', { formulationId: 'form-a2' })],
    ['a no-label entry described as used for something else', () => changeShelfEntry('entry-c', { noLabelPurpose: 'lighten' })],
    ['a product with another brand', () => changeShelfEntry('entry-a', { brand: 'Other' })],
    ['a product with another name', () => changeShelfEntry('entry-a', { name: 'Night Serum 2' })],
    ['a product with another variant', () => changeShelfEntry('entry-b', { variant: 'spf 50' })],
    // the rules
    ['another rules version', () => ({ ...BASE, rulesVersion: 'rules-fedcba9876543210' })],
    ['another group on a rule', () => withRules([{ ...BASE.rules[0]!, group: 'benzoyl-peroxide' }, BASE.rules[1]!])],
    ['a rule that loses its group', () => withRules([{ ...BASE.rules[0]!, group: null }, BASE.rules[1]!])],
    ['another clash on a rule', () => withRules([{ ...BASE.rules[0]!, clashesWith: ['exfoliating-acid', 'benzoyl-peroxide'] }, BASE.rules[1]!])],
    ['another concern a rule helps', () => withRules([BASE.rules[0]!, { ...BASE.rules[1]!, helps: ['hd_texture', 'hd_radiance'] }])],
    // the claim phrases and the step-down templates
    ['a claim phrase added', () => ({ ...BASE, claimPhrases: [...BASE.claimPhrases, 'fairness'] })],
    ['a claim phrase worded differently', () => ({ ...BASE, claimPhrases: ['whitening', 'bleach'] })],
    ['another approved steroid template', () => ({ ...BASE, tapers: { ...BASE.tapers, steroid: 'TPR-STEROID-2' } })],
    ['another approved lightening template', () => ({ ...BASE, tapers: { ...BASE.tapers, 'lightening-agent': 'TPR-LIGHTENING-2' } })],
    ['no approved steroid template', () => ({ ...BASE, tapers: { 'lightening-agent': 'TPR-LIGHTENING-1' } })],
    // the goal
    ['another goal', () => ({ ...BASE, goal: 'even-tone' })],
    ['no goal', () => ({ ...BASE, goal: null })],
    // the safety answers, by content
    ['a choice added', () => withView({ choices: ['reaction', 'prescription', 'pregnant'] })],
    ['a choice removed', () => withView({ choices: ['reaction'] })],
    ['other words for the reaction', () => withView({ reactionText: 'Night Cream and soap' })],
    ['other words for the prescription', () => withView({ prescriptionText: 'Betnovate' })],
    ['no safety answers at all', () => withSafety({ view: null, parseState: null, mentions: [] })],
    ['a parse that is no longer pending', () => withSafety({ parseState: 'pending' })],
    ['a parse that failed', () => withSafety({ parseState: 'failed' })],
    ['a mention left unresolved', () => withSafety({ mentions: [mention({ resolution: 'unresolved', productId: null }), BASE.safety.mentions[1]!] })],
    ['a mention that resolved to another product', () => withSafety({ mentions: [mention({ productId: 'prod-other' }), BASE.safety.mentions[1]!] })],
    ['a mention added', () => withSafety({ mentions: [...BASE.safety.mentions, mention({ id: 'mention-3', kind: 'ingredient', name: 'fragrance', brand: null, category: null, productId: null, resolution: null, position: 2 })] })],
    ['a mention that names another product', () => withSafety({ mentions: [mention({ name: 'Day Cream' }), BASE.safety.mentions[1]!] })],
    ['a mention that moved from reaction to prescription', () => withSafety({ mentions: [mention({ source: 'prescription' }), BASE.safety.mentions[1]!] })],
    // the face scan
    ['a concern that reads a different band', () => ({ ...BASE, scan: { ...BASE.scan!, concerns: [{ concern: 'hd_age_spot', band: 'clear' }, BASE.scan!.concerns[1]!] } })],
    ['a concern added to the scan', () => ({ ...BASE, scan: { ...BASE.scan!, concerns: [...BASE.scan!.concerns, { concern: 'hd_texture', band: 'faint' }] } })],
    ['another skin type', () => ({ ...BASE, scan: { ...BASE.scan!, skinType: 'dry' } })],
    ['no skin type', () => ({ ...BASE, scan: { ...BASE.scan!, skinType: null } })],
    ['no face scan', () => ({ ...BASE, scan: null })],
    // the model
    ['another model', () => ({ ...BASE, model: 'claude-sonnet-5-6' })],
    ['another prompt', () => ({ ...BASE, promptHash: 'prompt-hash-2' })],
  ]

  it.each(CHANGES)('changes with %s', async (_name, make) => {
    expect(await hashOf(make())).not.toBe(await hashOf(BASE))
  })

  it('gives every one of those changes its own hash, so no two inputs share a verdict', async () => {
    const hashes = await Promise.all(CHANGES.map(([, make]) => hashOf(make())))

    expect(new Set([...hashes, await hashOf(BASE)]).size).toBe(CHANGES.length + 1)
  })
})

import { describe, expect, it } from 'vitest'
import { routineFingerprint } from './routines.fingerprint'

// The routine's fingerprint is what its skeleton depends on, as one hash: a change to any input queues a rebuild, no change leaves the routine alone. It is a
// hash of the facts that decide the skeleton (goal, cautions, each shelf product's verdict and step, the rules version), so what the face scan shows (bands) is
// never an input: a rescan alone must not rebuild a routine.

type Input = Parameters<typeof routineFingerprint>[0]

const BASE: Input = {
  goal: 'even-tone',
  cautions: ['pregnant', 'tapering'],
  products: [
    { entryId: 'entry-a', verdict: { kind: 'keep' }, step: 'cleanse' },
    { entryId: 'entry-b', verdict: { kind: 'reduce', maxFrequency: 'alternate-days' }, step: 'treat' },
    { entryId: 'entry-c', verdict: { kind: 'stop', taperTemplateId: 'tpl-steroid' }, step: 'treat' },
  ],
  rulesVersion: '1',
}

const fingerprint = (over: Partial<Input> = {}) => routineFingerprint({ ...BASE, ...over })

describe('routineFingerprint', () => {
  it('is a 64-character lowercase hex string', async () => {
    expect(await fingerprint()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is the same for the same inputs', async () => {
    expect(await fingerprint()).toBe(await fingerprint())
  })

  it('is the same however the cautions are ordered', async () => {
    expect(await fingerprint({ cautions: ['tapering', 'pregnant'] })).toBe(await fingerprint({ cautions: ['pregnant', 'tapering'] }))
  })

  it('is the same however the products are ordered', async () => {
    expect(await fingerprint({ products: [...BASE.products].reverse() })).toBe(await fingerprint())
  })

  it('changes with the goal', async () => {
    expect(await fingerprint({ goal: 'glow' })).not.toBe(await fingerprint())
  })

  it('changes when a caution is added', async () => {
    expect(await fingerprint({ cautions: ['pregnant', 'tapering', 'recent-reaction'] })).not.toBe(await fingerprint())
  })

  it('changes when a caution is swapped for another', async () => {
    expect(await fingerprint({ cautions: ['breastfeeding', 'tapering'] })).not.toBe(await fingerprint())
  })

  it('changes when a product is added or taken off the shelf', async () => {
    expect(await fingerprint({ products: BASE.products.slice(0, 2) })).not.toBe(await fingerprint())
    expect(await fingerprint({ products: [...BASE.products, { entryId: 'entry-d', verdict: { kind: 'keep' }, step: 'protect' }] })).not.toBe(await fingerprint())
  })

  it('changes when a product has a different verdict', async () => {
    const products = BASE.products.map((p) => (p.entryId === 'entry-a' ? { ...p, verdict: { kind: 'drop' } as const } : p))

    expect(await fingerprint({ products })).not.toBe(await fingerprint())
  })

  it('changes when a reduced product is capped at a different frequency', async () => {
    const products = BASE.products.map((p) => (p.entryId === 'entry-b' ? { ...p, verdict: { kind: 'reduce', maxFrequency: 'weekly' } as const } : p))

    expect(await fingerprint({ products })).not.toBe(await fingerprint())
  })

  it('changes when a product fills a different step', async () => {
    const products = BASE.products.map((p) => (p.entryId === 'entry-a' ? { ...p, step: 'moisturise' } as const : p))

    expect(await fingerprint({ products })).not.toBe(await fingerprint())
  })

  it('changes when a product fills no step at all', async () => {
    const products = BASE.products.map((p) => (p.entryId === 'entry-a' ? { ...p, step: null } : p))

    expect(await fingerprint({ products })).not.toBe(await fingerprint())
  })

  it('changes when two products swap verdicts, so a verdict is tied to its own entry', async () => {
    const [a, b, c] = BASE.products
    const swapped = [{ ...a!, verdict: b!.verdict }, { ...b!, verdict: a!.verdict }, c!]

    expect(await fingerprint({ products: swapped })).not.toBe(await fingerprint())
  })

  it('changes with the rules version', async () => {
    expect(await fingerprint({ rulesVersion: '2' })).not.toBe(await fingerprint())
  })

  it('is unchanged by anything the skeleton does not depend on, such as the scan bands', async () => {
    const withExtras = { ...BASE, seen: [{ concern: 'hd_age_spot', level: 'some' }], skinType: 'oily', scanId: 'scan-9' } as unknown as Input

    expect(await routineFingerprint(withExtras)).toBe(await fingerprint())
  })

  it('is unchanged by extra fields on a product, such as its name', async () => {
    const products = BASE.products.map((p) => ({ ...p, name: `renamed ${p.entryId}` })) as unknown as Input['products']

    expect(await fingerprint({ products })).toBe(await fingerprint())
  })
})

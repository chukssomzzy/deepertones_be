import { describe, expect, it } from 'vitest'
import type { Recognition } from '../../src/providers/product-recognition/product-recognizer.provider'
import type { Label } from './matching-set'
import { seedReadingOf, type PhotoReading } from './shelf-seeds'

// seedReadingOf is pure: it only picks. Two products whose chosen identities share an identity key are handled by shelfSeeds
// (matching.ts), which falls a single-scan side back to its label; that is not tested here.

const LABEL: Label = { brand: 'Cantu', name: 'Curling Cream', variant: 'Coconut', form: 'cream', category: 'hair' }
const product = { folder: 'cantu', label: LABEL }

const beauty = (extra: Partial<Extract<Recognition, { classification: 'beauty-product' }>> = {}): Recognition => ({
  classification: 'beauty-product',
  brand: 'Cantu',
  name: 'Shea Butter Coconut Curling Cream',
  category: 'hair',
  confidence: 0.9,
  ...extra,
})
const read = (photo: string, recognition: Recognition): PhotoReading => ({ photo, recognition })

describe('seedReadingOf', () => {
  it('seeds from the first beauty-product reading, with the photo it came from', () => {
    const seed = seedReadingOf(product, [read('1.jpg', beauty())])
    expect(seed).toEqual({
      identity: { brand: 'Cantu', name: 'Shea Butter Coconut Curling Cream', category: 'hair' },
      source: 'single-scan',
      photo: '1.jpg',
    })
  })

  it('takes the first beauty reading in the order given, skipping unreadable photos and errors', () => {
    const seed = seedReadingOf(product, [
      read('1.jpg', { classification: 'label-not-visible' }),
      { photo: '2.jpg', error: 'AnthropicUnavailableError' },
      read('3.jpg', { classification: 'other-product' }),
      read('4.jpg', beauty({ name: 'Third' })),
      read('5.jpg', beauty({ name: 'Fourth' })),
    ])
    expect(seed.source).toBe('single-scan')
    expect(seed.photo).toBe('4.jpg')
    expect(seed.identity.name).toBe('Third')
  })

  it('uses the category the photo was read as, not the label category', () => {
    const seed = seedReadingOf(product, [read('1.jpg', beauty({ category: 'skin' }))])
    expect(seed.identity.category).toBe('skin')
  })

  it('keeps the reading variant and form', () => {
    const seed = seedReadingOf(product, [read('1.jpg', beauty({ variant: 'Coconut', form: 'cream' }))])
    expect(seed.identity).toEqual({ brand: 'Cantu', name: 'Shea Butter Coconut Curling Cream', category: 'hair', variant: 'Coconut', form: 'cream' })
  })

  it('drops an empty variant instead of keeping an empty string', () => {
    const seed = seedReadingOf(product, [read('1.jpg', beauty({ variant: '' }))])
    expect(seed.identity).not.toHaveProperty('variant')
  })

  it('does not borrow the label variant or form when the reading has none', () => {
    const seed = seedReadingOf(product, [read('1.jpg', beauty())])
    expect(seed.identity).not.toHaveProperty('variant')
    expect(seed.identity).not.toHaveProperty('form')
  })

  it('falls back to the label identity, source label and no photo, when no photo reads as a beauty product', () => {
    const seed = seedReadingOf(product, [
      read('1.jpg', { classification: 'unreadable' }),
      read('2.jpg', { classification: 'face-or-person' }),
      { photo: '3.jpg', error: 'AnthropicRefusalError' },
    ])
    expect(seed).toEqual({ identity: { brand: 'Cantu', name: 'Curling Cream', category: 'hair', variant: 'Coconut', form: 'cream' }, source: 'label' })
  })

  it('falls back to the label when there are no readings', () => {
    expect(seedReadingOf(product, []).source).toBe('label')
  })

  it('drops an empty label variant in the fallback and leaves its input untouched', () => {
    const bare = { folder: 'x', label: { brand: 'A', name: 'B', variant: '', category: 'skin' } as Label }
    const readings = [read('1.jpg', beauty())]
    const before = structuredClone({ bare, readings })
    expect(seedReadingOf(bare, []).identity).toEqual({ brand: 'A', name: 'B', category: 'skin' })
    seedReadingOf(bare, readings)
    expect({ bare, readings }).toEqual(before)
  })
})

import { describe, expect, it } from 'vitest'
import { FORBIDDEN_WORDING } from './routines.wording'

// A text is "caught" when any forbidden pattern matches it. Which pattern caught it is not what a caller sees, so the cases below
// say what must and must not be caught, not which entry does it.
const caught = (text: string) => FORBIDDEN_WORDING.some(({ pattern }) => pattern.test(text))

describe('FORBIDDEN_WORDING', () => {
  describe('the list itself', () => {
    it('is not empty, and each entry has a unique, non-empty code', () => {
      const codes = FORBIDDEN_WORDING.map((w) => w.code)

      expect(codes.length).toBeGreaterThan(0)
      expect(codes.every((c) => c.length > 0)).toBe(true)
      expect(new Set(codes).size).toBe(codes.length)
    })

    it('gives the same answer when asked twice about the same text', () => {
      // A global or sticky RegExp remembers where it stopped; a check run over many routines must not.
      expect(caught('You have melasma.')).toBe(true)
      expect(caught('You have melasma.')).toBe(true)
    })

    it('ignores case', () => {
      expect(caught('MELASMA')).toBe(true)
      expect(caught('Lighter Skin')).toBe(true)
      expect(caught('YOU SUFFER FROM it')).toBe(true)
      expect(caught('SKIN SCORE')).toBe(true)
    })
  })

  describe('condition names (we never diagnose)', () => {
    it.each([
      'melasma',
      'rosacea',
      'eczema',
      'dermatitis',
      'atopic dermatitis',
      'psoriasis',
      'vitiligo',
      'keloid',
      'keloids',
      'folliculitis',
      'pseudofolliculitis barbae',
      'seborrheic',
      'seborrhoeic',
      'tinea',
      'ringworm',
      'fungal infection',
      'acne vulgaris',
      'post-inflammatory hyperpigmentation',
      'PIH',
      'topical steroid withdrawal',
      'TSW',
    ])('catches "%s" in a sentence', (name) => {
      expect(caught(`This helps with ${name} over time.`)).toBe(true)
    })

    it.each([
      'Clears dark marks and breakouts.',
      'Helps with uneven tone, redness and dark circles.',
      'Gentle on sensitive, reactive skin.',
      'Good for the pith of a citrus peel.',
      'Disinfection is not something a cleanser does.',
      'Evens out skin tone over 8 to 12 weeks.',
    ])('does not catch the plain skin words in "%s"', (text) => {
      expect(caught(text)).toBe(false)
    })
  })

  describe('diagnosis phrasing', () => {
    it.each([
      'You have melasma.',
      'You have rosacea on your cheeks.',
      'You have a condition that needs care.',
      'You have an infection.',
      'You have a disease of the skin.',
      'You have a disorder of the skin.',
      'You suffer from dryness.',
      'We diagnose this early.',
      'This was diagnosed last year.',
      'A diagnosis comes from a doctor.',
    ])('catches "%s"', (text) => {
      expect(caught(text)).toBe(true)
    })

    it.each([
      'Use what you have.',
      'Use what you have for now.',
      'Keep going with the products you have.',
      'Rinse with the cleanser you have on your shelf.',
      'If you have sensitive skin, go slowly.',
      'Because you have oily skin, keep it light.',
      'You have a cleanser already, so keep it.',
      'You have a conditioner at home; skip it on your face.',
    ])('does not catch "%s"', (text) => {
      expect(caught(text)).toBe(false)
    })
  })

  describe('lightness as an outcome', () => {
    it.each([
      'You will get lighter skin.',
      'A lighter face in weeks.',
      'A lighter complexion by spring.',
      'A lighter tone overall.',
      'It lightens your skin.',
      'It lightens the face.',
      'Lightening your complexion takes time.',
      'Lightening the skin is not the aim here.',
      'Aim for fairer skin.',
      'Whiter skin in a month.',
      'A whitening routine.',
      'Skin bleaching works fast.',
    ])('catches "%s"', (text) => {
      expect(caught(text)).toBe(true)
    })

    it.each([
      'Stop the lightening cream slowly, over a few weeks.',
      'You are stopping your lightening cream.',
      'Brighter, more even skin takes patience.',
      'Aim for a brighter look.',
      'It brightens a dull complexion.',
      'A lighter moisturiser suits the heat.',
      'A lightweight gel with no white cast.',
      'Pat dry with a white towel.',
      'A fairly rich cream.',
    ])('does not catch "%s"', (text) => {
      expect(caught(text)).toBe(false)
    })
  })

  describe('grades and scores', () => {
    it.each([
      'Your skin score is up.',
      'A skin score of 80.',
      'You are at 7/10.',
      'About 8 out of 10.',
      '10/10 would recommend.',
      'Scoring 50/100 today.',
      'Roughly 72 out of 100.',
      'Your skin grade is a B.',
      'Your grade is improving.',
    ])('catches "%s"', (text) => {
      expect(caught(text)).toBe(true)
    })

    it.each([
      '10% niacinamide.',
      'Contains 2% salicylic acid.',
      'A 5% azelaic acid serum.',
      '100% fragrance free.',
      'Results show in 8 to 12 weeks.',
      'Use 2 out of 3 mornings.',
      'Apply 1/2 a teaspoon.',
      'Step up gradually.',
      'An upgrade on your old cleanser.',
    ])('does not catch "%s"', (text) => {
      expect(caught(text)).toBe(false)
    })
  })

  describe('ordinary good routine wording', () => {
    it.each([
      'A gentle cleanser that suits combination skin. Use it morning and night.',
      'Wear sunscreen every morning and reapply if you are outdoors.',
      'Niacinamide at 10% helps with uneven tone and dark marks over 8 to 12 weeks.',
      'Your serum is cut back to alternate days while your skin settles.',
      'You may notice the first change in about 8 weeks; dark marks fade slowly.',
      'Introduce one new product at a time.',
    ])('lets "%s" through', (text) => {
      expect(caught(text)).toBe(false)
    })
  })

  describe('false positives and evasions found in review', () => {
    it.each([
      'A lighter face cream suits humid weather.',
      'Use a lighter face wash at night.',
      'Swap to a lighter tone-matching sunscreen.',
      'Lighter skin care routine for summer.',
      'A lighter skincare routine.',
      'Choose a lighter skin lotion in the heat.',
      'This serum lightens the tone of dark marks gradually.',
      'This serum fades dark marks and lightens dark spots.',
      'Stop the skin lightening cream slowly.',
      'Use 1/10 of a teaspoon.',
      'Wait 5/10 minutes before moisturiser.',
      'Skin grade ingredients are not what we judge by.',
      'If you see signs of infection, stop and see a pharmacist.',
      'Watch for signs of a reaction or infection and stop if they appear.',
      'Wait 2 out of 10 minutes.',
    ])('does not catch "%s"', (text) => {
      expect(caught(text)).toBe(false)
    })

    it.each([
      'lighter skin',
      'A lighter-skin result.',
      'Lighter  complexion soon.',
      'Your skin will be lighter in a month.',
      'Your face looks lighter.',
      'Your skin will get visibly lighter.',
      'It lighten your skin.',
      'It lightened the skin.',
      'It lightens your face.',
      'Lightening-the-skin takes time.',
      'Lightening  your  complexion.',
      'Skin lightening in weeks.',
      'Skin-lightening results.',
      'Fair-er skin.',
      'fair er skin',
      'Skin-bleaching works.',
      'Rate it 9 out of ten.',
      'Rate it 8 outta 10.',
      'A 7/10 today.',
      'You were graded B.',
      'We grade your skin.',
      'You have infections on your face.',
      'Seborrhea on the scalp.',
      'Seborrheic patches.',
      'You may have a fungal infection.',
    ])('catches "%s"', (text) => {
      expect(caught(text)).toBe(true)
    })
  })
})

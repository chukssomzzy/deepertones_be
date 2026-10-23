/*
 * The dev set of `npm run eval:catalog -- --mode draft --set dev`: the products a drafter change is tuned and measured on. They come from the curated
 * recommendation catalog of 2026-10-23 and from products its safety screen dropped or rejected, and are deliberately outside DRAFT_CASES and
 * DRAFT_HOLDOUT, so a prompt or rule may be tuned against this set (the other two never may: see draft-cases.ts). No product may be in either of them
 * (draft-cases.test.ts).
 *
 * Every case is `ordinary` and has no `expected`: the run judges each drafted value against the page it cites, and a person looks at the rest. The
 * countries are where research found the product listed.
 */
import type { DraftCase } from './draft-cases'

export const DRAFT_DEV: DraftCase[] = [
  {
    id: 'la-roche-posay-effaclar-purifying-f',
    kind: 'ordinary',
    product: { brand: 'La Roche-Posay', name: 'Effaclar Purifying Foaming Gel', form: 'gel', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'la-roche-posay-effaclar-duo-m-anti',
    kind: 'ordinary',
    product: { brand: 'La Roche-Posay', name: 'Effaclar Duo+M Anti-Blemish Corrective Gel Moisturiser', variant: '40ml', form: 'gel', category: 'skin' },
    countries: ['GB'],
  },
  {
    id: 'acnecide-face-gel-spot-treatment-wi',
    kind: 'ordinary',
    product: { brand: 'Acnecide', name: 'Face Gel Spot Treatment with Benzoyl Peroxide 5%', variant: '15g', form: 'gel', category: 'skin' },
    countries: ['GB'],
  },
  {
    id: 'bioderma-sebium-kerato-anti-blemish',
    kind: 'ordinary',
    product: { brand: 'Bioderma', name: 'Sébium Kerato+ Anti-Blemish Gel Cream', variant: '30ml', form: 'gel', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'la-roche-posay-effaclar-mat-mattify',
    kind: 'ordinary',
    product: { brand: 'La Roche-Posay', name: 'Effaclar MAT+ Mattifying Moisturiser', variant: '40ml', form: 'cream', category: 'skin' },
    countries: ['GB'],
  },
  {
    id: 'cetaphil-oily-skin-oil-absorbing-mo',
    kind: 'ordinary',
    product: { brand: 'Cetaphil', name: 'Oily Skin Oil Absorbing Moisturizer SPF 30', variant: '118ml', form: 'lotion', category: 'skin' },
    countries: ['NG'],
  },
  {
    id: 'beauty-of-joseon-relief-sun-aqua-fr',
    kind: 'ordinary',
    product: { brand: 'Beauty of Joseon', name: 'Relief Sun: Aqua-Fresh Rice + B5 SPF50+ PA++++', variant: '50ml', form: 'lotion', category: 'skin' },
    countries: ['GB'],
  },
  {
    id: 'la-roche-posay-toleriane-dermo-clea',
    kind: 'ordinary',
    product: { brand: 'La Roche-Posay', name: 'Toleriane Dermo-Cleanser', variant: '200ml', form: 'lotion', category: 'skin' },
    countries: ['GB'],
  },
  {
    id: 'eucerin-anti-pigment-dual-serum',
    kind: 'ordinary',
    product: { brand: 'Eucerin', name: 'Anti-Pigment Dual Serum', variant: '30ml', form: 'serum', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'la-roche-posay-mela-b3-serum',
    kind: 'ordinary',
    product: { brand: 'La Roche-Posay', name: 'Mela B3 Serum', variant: '30ml', form: 'serum', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'cerave-moisturising-cream',
    kind: 'ordinary',
    product: { brand: 'CeraVe', name: 'Moisturising Cream', variant: '454g', form: 'cream', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'la-roche-posay-cicaplast-baume-b5',
    kind: 'ordinary',
    product: { brand: 'La Roche-Posay', name: 'Cicaplast Baume B5+', variant: '40ml', form: 'balm', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'cetaphil-moisturising-cream',
    kind: 'ordinary',
    product: { brand: 'Cetaphil', name: 'Moisturising Cream', variant: '450g', form: 'cream', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'the-ordinary-alpha-arbutin-2-ha',
    kind: 'ordinary',
    product: { brand: 'The Ordinary', name: 'Alpha Arbutin 2% + HA', variant: '30ml', form: 'serum', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'paula-s-choice-10-azelaic-acid-boos',
    kind: 'ordinary',
    product: { brand: "Paula's Choice", name: '10% Azelaic Acid Booster', variant: '30ml', form: 'serum', category: 'skin' },
    countries: ['GB'],
  },
  {
    id: 'cetaphil-daily-hydrating-moisturise',
    kind: 'ordinary',
    product: { brand: 'Cetaphil', name: 'Daily Hydrating Moisturiser with Hyaluronic Acid', variant: '88ml', form: 'lotion', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'beauty-of-joseon-relief-sun-rice-pr',
    kind: 'ordinary',
    product: { brand: 'Beauty of Joseon', name: 'Relief Sun: Rice + Probiotics SPF50+ PA++++', variant: '50ml', form: 'cream', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'la-roche-posay-retinol-b3-pure-reti',
    kind: 'ordinary',
    product: { brand: 'La Roche-Posay', name: 'Retinol B3 Pure Retinol Serum', variant: '30ml', form: 'serum', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'cerave-resurfacing-retinol-serum',
    kind: 'ordinary',
    product: { brand: 'CeraVe', name: 'Resurfacing Retinol Serum', variant: '30ml', form: 'serum', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'the-ordinary-hyaluronic-acid-2-b5',
    kind: 'ordinary',
    product: { brand: 'The Ordinary', name: 'Hyaluronic Acid 2% + B5', variant: '30ml', form: 'serum', category: 'skin' },
    countries: ['GB'],
  },
  {
    id: 'bioderma-sensibio-h2o-micellar-wate',
    kind: 'ordinary',
    product: { brand: 'Bioderma', name: 'Sensibio H2O Micellar Water', variant: '500ml', form: 'liquid', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'vanicream-gentle-facial-cleanser',
    kind: 'ordinary',
    product: { brand: 'Vanicream', name: 'Gentle Facial Cleanser', variant: '237ml', form: 'lotion', category: 'skin' },
    countries: ['NG'],
  },
  {
    id: 'avene-tolerance-control-extremely-g',
    kind: 'ordinary',
    product: { brand: 'Avène', name: 'Tolerance Control Extremely Gentle Cleanser', variant: '200ml', form: 'lotion', category: 'skin' },
    countries: ['GB'],
  },
  {
    id: 'aquaphor-healing-ointment',
    kind: 'ordinary',
    product: { brand: 'Aquaphor', name: 'Healing Ointment', variant: '198g', form: 'balm', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'skin1004-madagascar-centella-ampoul',
    kind: 'ordinary',
    product: { brand: 'SKIN1004', name: 'Madagascar Centella Ampoule', variant: '100ml', form: 'serum', category: 'skin' },
    countries: ['GB'],
  },
  {
    id: 'avene-cicalfate-restorative-protect',
    kind: 'ordinary',
    product: { brand: 'Avène', name: 'Cicalfate+ Restorative Protective Cream', variant: '40ml', form: 'cream', category: 'skin' },
    countries: ['GB'],
  },
  {
    id: 'avene-tolerance-control-soothing-sk',
    kind: 'ordinary',
    product: { brand: 'Avène', name: 'Tolerance Control Soothing Skin Recovery Cream', variant: '40ml', form: 'cream', category: 'skin' },
    countries: ['GB'],
  },
  {
    id: 'aveeno-calm-restore-oat-gel-moistur',
    kind: 'ordinary',
    product: { brand: 'Aveeno', name: 'Calm + Restore Oat Gel Moisturiser', variant: '50ml', form: 'gel', category: 'skin' },
    countries: ['GB'],
  },
  {
    id: 'bioderma-sebium-foaming-gel-gel-mou',
    kind: 'ordinary',
    product: { brand: 'Bioderma', name: 'Sébium Foaming Gel (Gel Moussant)', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'bioderma-pigmentbio-foaming-cream-b',
    kind: 'ordinary',
    product: { brand: 'Bioderma', name: 'Pigmentbio Foaming Cream Brightening Exfoliating Cleanser', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'the-ordinary-caffeine-solution-5-eg',
    kind: 'ordinary',
    product: { brand: 'The Ordinary', name: 'Caffeine Solution 5% + EGCG', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'la-roche-posay-mela-b3-eyes-intensi',
    kind: 'ordinary',
    product: { brand: 'La Roche-Posay', name: 'Mela B3 Eyes Intensive Dark Circles Corrector', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'bioderma-photoderm-xdefense-ultra-f',
    kind: 'ordinary',
    product: { brand: 'Bioderma', name: 'Photoderm XDefense Ultra Fluid SPF50+', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'facefacts-ceramide-hydrating-gentle',
    kind: 'ordinary',
    product: { brand: 'FaceFacts', name: 'Ceramide Hydrating Gentle Cleanser', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'skinscience-benzoyl-peroxide-5-wash',
    kind: 'ordinary',
    product: { brand: 'SkinScience', name: 'Benzoyl Peroxide 5% Wash', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'la-roche-posay-toleriane-double-rep',
    kind: 'ordinary',
    product: { brand: 'La Roche-Posay', name: 'Toleriane Double Repair Face Moisturizer', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'facefacts-nourish-restore-ceramide',
    kind: 'ordinary',
    product: { brand: 'FaceFacts', name: 'Nourish + Restore Ceramide Serum', category: 'skin' },
    countries: ['NG', 'GB'],
  },
  {
    id: 'bioderma-photoderm-ultra-fluid-ar-s',
    kind: 'ordinary',
    product: { brand: 'Bioderma', name: 'Photoderm Ultra-Fluid AR+ SPF50+', category: 'skin' },
    countries: ['NG', 'GB'],
  },
]

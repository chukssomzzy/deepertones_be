/*
 * The holdout set of `npm run eval:catalog -- --mode draft --set holdout`: products the drafter was never tuned against, for checking that a drafter fix
 * helps beyond the measurement set (DRAFT_CASES). Same shape and rules as DRAFT_CASES (see draft-cases.ts for what `kind` and `expected` mean), and no
 * product may be in both sets (draft-cases.test.ts). A product that has been used to tune a prompt belongs in DRAFT_CASES's world, not here: retire it
 * from the holdout and add a fresh one.
 *
 * Evidence pages marked "snippet only" were not readable when the case was written (the page blocked automated fetches); the values they back come from
 * a search snippet.
 */
import type { DraftCase } from './draft-cases'

export const DRAFT_HOLDOUT: DraftCase[] = [
  // dang-vitamin-c-oil-free-serum (was dang-vitamin-c-concentrated-serum-oil-free)
  // Why: Lagos-founded brand selling in NGN from its own store; a 7% ethyl ascorbic acid serum for dark spots and post-acne marks on oily skin. The
  // page offers 30ml and 15ml but shows a single sale price, so a drafted price should not be assigned to one size without care. The site lists a
  // UK shipping option but shows no GBP prices, so GB stock is not established (the case asks about NG only).
  // Evidence pages:
  //   https://danglifestyle.co/products/vitamin-c-serum-for-oily-skin
  //   https://danglifestyle.co/
  {
    id: 'dang-vitamin-c-oil-free-serum',
    kind: 'ordinary',
    product: { brand: 'Dang', name: 'Vitamin C Concentrated Serum for Face (Oil Free)', form: 'serum', category: 'skin' },
    countries: ['NG'],
    expected: { skinConcernsPlausible: ['hd_age_spot', 'hd_radiance', 'hd_acne'], skinTypesPlausible: ['oily', 'combination'], stepsPlausible: ['treat'], frequencyPlausible: ['am', 'pm', 'am-pm'], soldIn: { NG: true } },
  },
  // qa-azelaic-acid-balancing-serum
  // Why: UK-made azelaic acid serum listed in Nigeria by a pharmacy and in the UK by several retailers; UK retailers call it 'Azelaic Acid Facial
  // Serum' while the brand and the Nigerian page say 'Balancing Serum'. The Nigerian page describes it for sensitive, redness-prone skin whereas the
  // brand and UK retailers say oily, stressed, combination and normal skin, so the skin-type set is deliberately generous and the sources conflict.
  // Evidence pages:
  //   https://www.qandaskin.com/products/azelaic-acid-balancing-serum
  //   https://www.jarrolds.co.uk/departments/beauty/skin-care/serums/q-and-a-azelaic-acid-facial-serum-30ml
  //   https://gomed.ng/product/q-a-azelaic-acid-balancing-serum-30ml
  //   https://www.hollandandbarrett.com/shop/product/qa-azelaic-acid-facial-serum-30ml-60061312 (snippet only)
  {
    id: 'qa-azelaic-acid-balancing-serum',
    kind: 'ordinary',
    product: { brand: 'Q+A', name: 'Azelaic Acid Balancing Serum', form: 'serum', category: 'skin' },
    countries: ['NG', 'GB'],
    expected: { skinConcernsPlausible: ['hd_acne', 'hd_pore', 'hd_oiliness', 'hd_redness', 'hd_radiance', 'hd_texture'], skinTypesPlausible: ['oily', 'combination', 'normal'], stepsPlausible: ['treat'], frequencyPlausible: ['am', 'pm', 'am-pm'], soldIn: { NG: true, GB: true } },
  },
  // axis-y-dark-spot-glow-serum (was axis-y-dark-spot-correcting-glow-serum)
  // Why: Korean 5% niacinamide serum for dark spots and post-acne marks, widely wanted for hyperpigmentation on deeper skin; stocked by a Nigerian
  // pharmacy (two listings at different prices) and several UK retailers. The brand's US store prices are in USD and must not be reused. Skin-type
  // wording differs between the Nigerian page (all, especially acne-prone and sensitive) and the UK page (all, including oily).
  // Evidence pages:
  //   https://www.axis-y.com/products/dark-spot-correcting-glow-serum
  //   https://gomed.ng/product/axis-y-dark-spot-correcting-glow-serum-50ml
  //   https://pureseoul.co.uk/products/axis-y-dark-spot-correcting-glow-serum
  //   https://www.superdrug.com/skin/face-skin-care/face-serums/axis-y-dark-spot-correcting-glow-serum/p/856910 (snippet only)
  {
    id: 'axis-y-dark-spot-glow-serum',
    kind: 'ordinary',
    product: { brand: 'AXIS-Y', name: 'Dark Spot Correcting Glow Serum', form: 'serum', category: 'skin' },
    countries: ['NG', 'GB'],
    expected: { skinConcernsPlausible: ['hd_age_spot', 'hd_radiance', 'hd_acne', 'hd_redness'], skinTypesPlausible: ['all'], stepsPlausible: ['treat'], frequencyPlausible: ['am', 'pm', 'am-pm'], soldIn: { NG: true, GB: true } },
  },
  // neutrogena-hydro-boost-water-gel
  // Why: Very common UK hyaluronic gel moisturiser (GB-only case). The Nigerian pharmacy listing found is a different item (Hydro Boost Water Cream),
  // so Nigerian availability of the Water Gel should not be assumed from it. The UK brand page says normal and combination skin; retailers add dry
  // and sensitive, so the skin-type set is generous.
  // Evidence pages:
  //   https://www.neutrogena.co.uk/skincare/moisturisers/hydro-boost-water-gel (snippet only)
  //   https://chemistdirect.co.uk/neutrogena-hydro-boost-water-gel/prd-0145658 (snippet only)
  //   https://www.justmylook.com/products/neutrogena-hydro-boost-water-gel-moisturiser-50ml
  {
    id: 'neutrogena-hydro-boost-water-gel',
    kind: 'ordinary',
    product: { brand: 'Neutrogena', name: 'Hydro Boost Water Gel', form: 'gel', category: 'skin' },
    countries: ['GB'],
    expected: { skinConcernsPlausible: ['hd_moisture'], skinTypesPlausible: ['normal', 'combination', 'dry'], stepsPlausible: ['moisturise'], frequencyPlausible: ['am', 'pm', 'am-pm'], soldIn: { GB: true } },
  },
  // neutrogena-oil-free-acne-wash
  // Why: 2% salicylic acid face wash stocked by a Nigerian pharmacy; a US-labelled acne treatment, so the brand page is a US page (UK Neutrogena sells
  // a different 'Clear & Defend' wash, so nothing may be taken from the UK range). Siblings exist (Pink Grapefruit, Cream Cleanser, Daily Scrub). The
  // Nigerian page states no size.
  // Evidence pages:
  //   https://www.neutrogena.com/products/skincare/oil-free-acne-wash-with-salicylic-acid/6811719 (snippet only)
  //   https://gomed.ng/product/neutrogena-oil-free-acne-wash
  {
    id: 'neutrogena-oil-free-acne-wash',
    kind: 'ordinary',
    product: { brand: 'Neutrogena', name: 'Oil-Free Acne Wash', form: 'gel', category: 'skin' },
    countries: ['NG'],
    expected: { skinConcernsPlausible: ['hd_acne', 'hd_oiliness', 'hd_pore'], skinTypesPlausible: ['oily', 'combination'], stepsPlausible: ['cleanse'], frequencyPlausible: ['am', 'pm', 'am-pm'], soldIn: { NG: true } },
  },
  // eucerin-sun-face-oil-control-spf50 (was eucerin-sun-face-oil-control-gel-cream-dry-touch-spf50)
  // Why: The FACE sunscreen (50ml; oily and blemish-prone skin) shares near-identical names with the 200ml BODY 'Sun Gel-Cream Dry Touch Oil Control' and
  // 'Dry Touch Sensitive Protect' (all skin types including sensitive). The Nigerian retailer page found is for the 200ml body product, and its URL slug
  // says 'Sensitive Protect' while the page title says 'Oil Control'. Skin types, size and price are easy to mix up.
  // Trap: What the scorer enforces is that no value is cited from a page the judge says is about a different product (exactProduct 'no' fails the
  // case): the Nigerian listing and its NGN price are for the 200ml body sibling, so an NG availability row cited from it, or skin types cited from
  // the body pages, is the failure. Whether the skin types are the face product's (oily and blemish-prone, not 'all skin types incl. sensitive') is not
  // enforced: the plausible sets are reported as agree or disagree and never gate.
  // Evidence pages:
  //   https://www.lookfantastic.com/p/eucerin-sun-face-oil-control-sun-gel-cream-dry-touch-spf50-50ml/12510296/
  //   https://www.beautybay.com/p/eucerin/sun-face-oil-control-sun-gel-cream-dry-touch-spf50 (snippet only)
  // Sibling pages (the body product, not this one):
  //   https://www.eucerin.co.uk/products/sun-protection/sun-gel-cream-dry-touch-oil-control-spf-50plus
  //   https://www.caretobeauty.com/ng/eucerin-sun-sensitive-protect-dry-touch-sun-gel-cream-spf50-200ml/
  {
    id: 'eucerin-sun-face-oil-control-spf50',
    kind: 'trap-sibling',
    product: { brand: 'Eucerin', name: 'Sun Face Oil Control Sun Gel-Cream Dry Touch', variant: 'SPF 50+', form: 'gel', category: 'skin' },
    countries: ['NG', 'GB'],
    expected: { skinConcernsPlausible: ['hd_oiliness', 'hd_acne', 'hd_pore', 'hd_age_spot'], skinTypesPlausible: ['oily', 'combination'], stepsPlausible: ['protect'], frequencyPlausible: ['am', 'as-needed'], soldIn: { NG: 'unknown', GB: true } },
  },
  // garnier-micellar-water-sensitive (was garnier-micellar-cleansing-water-sensitive-skin)
  // Why: Sold in several pack sizes with clearly different prices (100ml to 700ml); the Nigerian retailer shows 100ml with 400ml and 700ml as other
  // options, UK retailers show 400ml and 700ml. A drafted price must be for one stated size, never a figure blended across sizes. A Brightening variant
  // on a Nigerian pharmacy site is a different product.
  // Evidence pages:
  //   https://www.garnier.co.uk/our-brands/skin-care/micellar/micellar-cleansing-water-sensitive-skin
  //   https://www.caretobeauty.com/ng/garnier-micellar-cleansing-water-sensitive-skin-100ml/
  //   https://boots.com/garnier-micellar-cleansing-water-400ml-10169115 (snippet only)
  {
    id: 'garnier-micellar-water-sensitive',
    kind: 'ordinary',
    product: { brand: 'Garnier', name: 'Micellar Cleansing Water', variant: 'Sensitive Skin', form: 'liquid', category: 'skin' },
    countries: ['NG', 'GB'],
    expected: { skinConcernsPlausible: ['hd_moisture'], skinTypesPlausible: ['all'], stepsPlausible: ['cleanse'], frequencyPlausible: ['am', 'pm', 'am-pm'], soldIn: { NG: true, GB: true } },
  },
  // vicks-vaporub
  // Why: Real, heavily stocked cold-relief chest rub (menthol, camphor, eucalyptus) sold by pharmacies in both markets; it is rubbed on the skin but is
  // a cough, congestion and muscle-ache remedy, not a skincare routine product. Tests that the drafter does not invent concerns, a routine step,
  // frequency or skin type for a topical product that merely touches skin.
  // Trap: Empty lists mean leave empty: no HD skin concern, no cleanse/treat/moisturise/protect step, no routine frequency and no skin type. Availability
  // rows with a retailer and price are acceptable (the judge checks each price against its page; a price blended across the 50g, 100g and 4-in-1
  // listings would show there), but nothing routine-related.
  // Evidence pages:
  //   https://gomed.ng/product/vicks-vaporub-100g
  //   https://www.vicks.co.uk/products/decongestants/vicks-vaporub-ointment
  {
    id: 'vicks-vaporub',
    kind: 'trap-not-skincare',
    product: { brand: 'Vicks', name: 'VapoRub', form: 'balm', category: 'skin' },
    countries: ['NG', 'GB'],
    expected: { soldIn: { NG: true, GB: true } },
  },
]

/*
 * The measurement set of `npm run eval:catalog -- --mode draft`: products the catalog drafter is asked about, and what a sound draft of each looks like.
 *
 * A case is a product (as it would be typed into a draft Products row) and the countries to price it in. `kind` says what the case measures:
 *   ordinary               a real, sold product: the values are judged against the pages the drafter cites.
 *   trap-sibling           a product with a near-identical sibling in the same range: a value taken from the sibling's page is the failure.
 *   trap-foreign-currency  a product with no price in the local currency: a price row for the country that has none is the failure. (No case of this kind
 *                          is in the set today: the two that were turned out to be sold in Nigeria. The scorer still supports it.)
 *   trap-unbranded         a product that does not exist under that brand: nothing may be drafted for it.
 *   trap-not-skincare      a product that is not for a skincare routine: no skincare cell (concerns, skin types, steps, frequency) may be drafted for it.
 *
 * `expected` is not ground truth and never gates the run. Each `...Plausible` list is the set of values a reasonable reader of the product's pages could
 * defend, so a drafted value outside it is reported as a disagreement for a person to look at; `soldIn` says where the product is known to be sold
 * (true), known not to have a local price (false) or not established ("unknown"). Brands reformulate and shops come and go, so a failing case may be
 * out of date. The set is a measurement set: do not tune a prompt to it (a prompt change is checked on products outside it).
 */
import type { ProductIdentity } from '../../src/providers/product-research/product-researcher.provider'

export type DraftCaseKind = 'ordinary' | 'trap-sibling' | 'trap-foreign-currency' | 'trap-unbranded' | 'trap-not-skincare'

export type DraftExpected = {
  skinConcernsPlausible?: string[]
  skinTypesPlausible?: string[]
  stepsPlausible?: string[]
  frequencyPlausible?: string[]
  /** By country code, only for countries the case asks about. */
  soldIn?: Record<string, boolean | 'unknown'>
}

export type DraftCase = {
  /** Becomes the product code EVAL-<ID>, so lower case letters, digits and hyphens, at most 35 characters. */
  id: string
  kind: DraftCaseKind
  product: ProductIdentity
  /** Country codes to price the product in; each must be one the eval's Countries tab has (NG, GB). */
  countries: string[]
  expected?: DraftExpected
}

export const DRAFT_CASES: DraftCase[] = [
  // cerave-hydrating-facial-cleanser
  // Why: Mass-market gentle cleanser with a clear manufacturer page (normal to dry skin) and listings in both markets; UK name is 'Hydrating
  // Cleanser'.
  // Evidence pages:
  //   https://www.cerave.com/skincare/cleansers/hydrating-facial-cleanser
  //   https://www.cerave.co.uk/skincare/cleansers/hydrating-cleanser
  //   https://gomed.ng/product/cerave-hydrating-facial-cleanser-335ml
  //   https://www.superdrug.com/p/769990
  {
    id: 'cerave-hydrating-facial-cleanser',
    kind: 'ordinary',
    product: { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', form: 'cream', category: 'skin' },
    countries: ['NG', 'GB'],
    expected: { skinConcernsPlausible: ['hd_moisture'], skinTypesPlausible: ['dry', 'normal'], stepsPlausible: ['cleanse'], frequencyPlausible: ['am', 'pm', 'am-pm', 'as-needed'], soldIn: { NG: true, GB: true } },
  },
  // the-ordinary-niacinamide-10-zinc-1
  // Why: Very common niacinamide serum for oiliness, pores and uneven tone; sold in Nigerian pharmacies and the brand's UK site.
  // Evidence pages:
  //   https://theordinary.com/en-gb/niacinamide-10-zinc-1-serum-100436.html
  //   https://gomed.ng/product/the-ordinary-niacinamide-10-zinc-1-30ml
  {
    id: 'the-ordinary-niacinamide-10-zinc-1',
    kind: 'ordinary',
    product: { brand: 'The Ordinary', name: 'Niacinamide 10% + Zinc 1%', form: 'serum', category: 'skin' },
    countries: ['NG', 'GB'],
    expected: { skinConcernsPlausible: ['hd_oiliness', 'hd_pore', 'hd_acne', 'hd_texture', 'hd_radiance'], skinTypesPlausible: ['all'], stepsPlausible: ['treat'], frequencyPlausible: ['am', 'pm', 'am-pm'], soldIn: { NG: true, GB: true } },
  },
  // simple-refreshing-facial-wash-gel
  // Why: Cheap sensitive-skin gel cleanser stocked by Nigerian pharmacies and UK high street; manufacturer page has no stated concern, so
  // concerns should stay sparse. 'Moisturising' sibling exists but this name is unambiguous.
  // Evidence pages:
  //   https://www.simple.co.uk/p/kind-to-skin-refreshing-facial-gel-wash.html/05011451103863
  //   https://wellness.gomed.ng/product/simple-refreshing-facial-wash-150ml
  //   https://www.lookfantastic.com/p/simple-kind-to-skin-face-wash-refreshing-150ml/12741003/
  {
    id: 'simple-refreshing-facial-wash-gel',
    kind: 'ordinary',
    product: { brand: 'Simple', name: 'Kind to Skin Refreshing Facial Wash Gel', form: 'gel', category: 'skin' },
    countries: ['NG', 'GB'],
    expected: { skinTypesPlausible: ['all'], stepsPlausible: ['cleanse'], frequencyPlausible: ['am', 'pm', 'am-pm'], soldIn: { NG: true, GB: true } },
  },
  // cetaphil-gentle-skin-cleanser
  // Why: Dermatologist-recommended gentle cleanser widely sold in Nigerian pharmacies; brand page says normal to dry or sensitive, retailers say
  // all skin types, so skin-type set is deliberately broad.
  // Evidence pages:
  //   https://www.cetaphil.co.uk/cleansers/gentle-skin-cleanser/5020465202554.html
  //   https://gomed.ng/product/cetaphil-gentle-skin-cleanser-473ml
  //   https://www.cetaphil.com/us/products/product-categories/all-cleansers/cetaphil-gentle-skin-cleanser/302990110227.html
  //   https://www.superdrug.com/Skin/Face-Skin-Care/Cleansers/Cleansing-Lotion/Cetaphil-Gentle-Skin-Cleanser-236ml/p/599962
  {
    id: 'cetaphil-gentle-skin-cleanser',
    kind: 'ordinary',
    product: { brand: 'Cetaphil', name: 'Gentle Skin Cleanser', form: 'lotion', category: 'skin' },
    countries: ['NG', 'GB'],
    expected: { skinTypesPlausible: ['all'], stepsPlausible: ['cleanse'], frequencyPlausible: ['am', 'pm', 'am-pm', 'as-needed'], soldIn: { NG: true, GB: true } },
  },
  // dudu-osun-black-soap-classic
  // Why: The archetypal Nigerian African black soap; Nigerian retailers make strong dark-spot claims while the UK retailer makes none, so the
  // drafter must source concerns carefully. Classic and Pure variants exist.
  // Evidence pages:
  //   https://gomed.ng/product/dudu-osun-black-soap-150g
  //   https://www.ecco-verde.co.uk/dudu-osun/black-soap-classic
  //   https://en.wikipedia.org/wiki/Dudu-Osun
  {
    id: 'dudu-osun-black-soap-classic',
    kind: 'ordinary',
    product: { brand: 'Dudu-Osun', name: 'Black Soap', variant: 'Classic', form: 'bar', category: 'skin' },
    countries: ['NG', 'GB'],
    expected: { skinConcernsPlausible: ['hd_acne', 'hd_age_spot'], skinTypesPlausible: ['all'], stepsPlausible: ['cleanse'], soldIn: { NG: true, GB: true } },
  },
  // vaseline-original-petroleum-jelly
  // Why: Ubiquitous in Nigerian shops, simple occlusive; sold as 'Protecting Jelly Original' in the UK and 'Blue Seal Original' on many NG
  // shelves, so the identity name 'Original Petroleum Jelly' is not any one market's exact label.
  // Evidence pages:
  //   https://wellness.gomed.ng/product/vaseline-original-100ml
  //   https://www.vaseline.com/uk/p/vaseline-protecting-jelly-original.html/00000042182627
  //   https://www.superdrug.com/p/253850
  {
    id: 'vaseline-original-petroleum-jelly',
    kind: 'ordinary',
    product: { brand: 'Vaseline', name: 'Original Petroleum Jelly', form: 'balm', category: 'skin' },
    countries: ['NG', 'GB'],
    expected: { skinConcernsPlausible: ['hd_moisture'], skinTypesPlausible: ['all'], stepsPlausible: ['moisturise', 'protect'], frequencyPlausible: ['as-needed', 'am-pm', 'pm'], soldIn: { NG: true, GB: true } },
  },
  // bio-oil-skincare-oil
  // Why: Hugely popular in Nigeria for marks and uneven tone; manufacturer has a Nigeria locale and states twice-daily use; counterfeits are
  // common so source quality matters.
  // Evidence pages:
  //   https://www.bio-oil.com/ng/en/products/SCO/information
  //   https://www.jumia.com.ng/bio-oil-specialist-skincare-oil-25ml-414506930.html
  //   https://gomed.ng/product/bio-oil-60ml
  {
    id: 'bio-oil-skincare-oil',
    kind: 'ordinary',
    product: { brand: 'Bio-Oil', name: 'Skincare Oil', form: 'oil', category: 'skin' },
    countries: ['NG'],
    expected: { skinConcernsPlausible: ['hd_age_spot', 'hd_radiance', 'hd_texture', 'hd_moisture'], skinTypesPlausible: ['all'], stepsPlausible: ['treat', 'moisturise'], frequencyPlausible: ['am', 'pm', 'am-pm'], soldIn: { NG: true } },
  },
  // arami-essentials-onyx-polish
  // Why: Real Lagos-based brand with its own store priced in NGN; a black-soap cleanser with explicit skin-type guidance (not for sensitive
  // skin; 'Onyx Light' is the unscented sibling).
  // Evidence pages:
  //   https://aramiessentials.com/products/onyx-polish
  //   https://aramiessentials.com
  //   https://blkgrn.com/products/edens-elixir
  {
    id: 'arami-essentials-onyx-polish',
    kind: 'ordinary',
    product: { brand: 'Arami Essentials', name: 'Onyx Polish', category: 'skin' },
    countries: ['NG'],
    expected: { skinConcernsPlausible: ['hd_acne', 'hd_age_spot', 'hd_radiance'], skinTypesPlausible: ['normal', 'oily', 'combination'], stepsPlausible: ['cleanse'], soldIn: { NG: true } },
  },
  // arami-essentials-glow-oil
  // Why: Shea-based body oil from a Nigerian brand; tests a shea product whose page is clear about concerns and use but which is a body/hair oil
  // rather than a face product.
  // Evidence pages:
  //   https://aramiessentials.com/products/glow-oil
  {
    id: 'arami-essentials-glow-oil',
    kind: 'ordinary',
    product: { brand: 'Arami Essentials', name: 'Glow Oil', form: 'oil', category: 'skin' },
    countries: ['NG'],
    expected: { skinConcernsPlausible: ['hd_moisture', 'hd_texture'], skinTypesPlausible: ['all'], stepsPlausible: ['moisturise'], frequencyPlausible: ['am', 'pm', 'am-pm', 'as-needed'], soldIn: { NG: true } },
  },
  // nivea-uv-super-water-gel-spf50
  // Why: No-white-cast gel sunscreen stocked by a Nigerian pharmacy; very relevant to darker skin; UK availability was not checked and should
  // not be assumed.
  // Evidence pages:
  //   https://gomed.ng/product/nivea-uv-super-water-gel-spf-50
  {
    id: 'nivea-uv-super-water-gel-spf50',
    kind: 'ordinary',
    product: { brand: 'Nivea', name: 'UV Super Water Gel', variant: 'SPF 50', form: 'gel', category: 'skin' },
    countries: ['NG'],
    expected: { skinConcernsPlausible: ['hd_age_spot'], skinTypesPlausible: ['all'], stepsPlausible: ['protect'], frequencyPlausible: ['am', 'as-needed'], soldIn: { NG: true } },
  },
  // cerave-mineral-sunscreen-spf50 (was cerave-hydrating-mineral-sunscreen-spf50-face-lotion)
  // Why: Mineral sunscreen with a known white-cast issue on deeper skin; Nigerian pharmacy page mentions it, so a good drafter should surface
  // that caution without over-claiming.
  // Evidence pages:
  //   https://www.cerave.com/sunscreen/face/hydrating-mineral-sunscreen-face-lotion-spf-50
  //   https://gomed.ng/product/cerave-hydrating-mineral-sunscreen-spf-50
  {
    id: 'cerave-mineral-sunscreen-spf50',
    kind: 'ordinary',
    product: { brand: 'CeraVe', name: 'Hydrating Mineral Sunscreen Face Lotion', variant: 'SPF 50', form: 'lotion', category: 'skin' },
    countries: ['NG'],
    expected: { skinConcernsPlausible: ['hd_age_spot'], skinTypesPlausible: ['all'], stepsPlausible: ['protect'], frequencyPlausible: ['am', 'as-needed'], soldIn: { NG: true } },
  },
  // palmers-cocoa-butter-daily-therapy (was palmers-cocoa-butter-formula-daily-skin-therapy)
  // Why: Cocoa-butter body lotion that is a staple in Nigerian pharmacies and supermarkets; several sizes and near-duplicate names (Daily
  // Therapy, Heals and Softens) test name matching.
  // Evidence pages:
  //   https://gomed.ng/product/palmer-s-cocoa-butter-formula-500ml
  //   https://gomed.ng/product/palmer-s-cocoa-butter-formula-daily-therapy-lotion-350ml
  {
    id: 'palmers-cocoa-butter-daily-therapy',
    kind: 'ordinary',
    product: { brand: 'Palmer\'s', name: 'Cocoa Butter Formula Daily Skin Therapy', form: 'lotion', category: 'skin' },
    countries: ['NG'],
    expected: { skinConcernsPlausible: ['hd_moisture', 'hd_texture'], skinTypesPlausible: ['dry', 'normal'], stepsPlausible: ['moisturise'], frequencyPlausible: ['am-pm', 'pm', 'as-needed'], soldIn: { NG: true } },
  },
  // boots-soltan-protect-moisturise-30 (was boots-soltan-protect-moisturise-lotion-spf30)
  // Why: UK own-brand sun lotion (GB-only case); Nigerian availability should not be invented for a retailer's house brand.
  // Evidence pages:
  //   https://boots.com/soltan-protect-and-moisturise-lotion-spf30-200ml-10245680
  //   https://www.which.co.uk/reviews/sun-creams/boots-soltan-protect-moisturise-lotion-spf30
  {
    id: 'boots-soltan-protect-moisturise-30',
    kind: 'ordinary',
    product: { brand: 'Boots Soltan', name: 'Protect & Moisturise Lotion', variant: 'SPF30', form: 'lotion', category: 'skin' },
    countries: ['GB'],
    expected: { skinConcernsPlausible: ['hd_age_spot'], skinTypesPlausible: ['all'], stepsPlausible: ['protect'], frequencyPlausible: ['am', 'as-needed'], soldIn: { GB: true } },
  },
  // inkey-list-niacinamide-serum
  // Why: GB-only case in this set (UK high street serum); its name is close to The Ordinary's niacinamide, and a 20% 'Excess Oil Solution'
  // sibling exists.
  // Evidence pages:
  //   https://www.lookfantastic.com/the-inkey-list-niacinamide-serum-30ml/12211781.html
  //   https://boots.com/niacinamide-serum-10311220
  {
    id: 'inkey-list-niacinamide-serum',
    kind: 'ordinary',
    product: { brand: 'The INKEY List', name: 'Niacinamide Serum', form: 'serum', category: 'skin' },
    countries: ['GB'],
    expected: { skinConcernsPlausible: ['hd_oiliness', 'hd_pore', 'hd_acne', 'hd_redness', 'hd_radiance'], skinTypesPlausible: ['all'], stepsPlausible: ['treat'], frequencyPlausible: ['am', 'pm', 'am-pm'], soldIn: { GB: true } },
  },
  // lrp-uvmune-400-oil-control (was lrp-anthelios-uvmune-400-oil-control-fluid)
  // Why: The same Anthelios UVMune 400 name has an Invisible Fluid (sensitive, all skin types), a Tinted fluid and this Oil Control version
  // (combination to oily); pages and prices are easily mixed up.
  // Trap: What the scorer enforces is that no value is cited from a page the judge says is about a different product (exactProduct 'no' fails the
  // case): a drafter that cites the Invisible Fluid or Tinted page for a value has fallen for the sibling. Whether the values themselves are right
  // is not enforced: the plausible sets (oily, combination; not 'all skin types / sensitive') are reported as agree or disagree and never gate, and a
  // discontinued UK listing is for a person to notice.
  // Evidence pages:
  //   https://gomed.ng/product/la-roche-posay-anthelios-uvmune-400-50-fluid-oil-control-50ml
  //   https://www.laroche-posay.co.uk/en_GB/anthelios-uvmune-400-oil-control-invisible-fluid/LRP_930.html
  //   https://africa.laroche-posay.com/en-za/anthelios/anthelios-uvmune/anthelios-uvmune-400-invisible-fluid-spf50-plus-non-perfumed
  {
    id: 'lrp-uvmune-400-oil-control',
    kind: 'trap-sibling',
    product: { brand: 'La Roche-Posay', name: 'Anthelios UVMune 400', variant: 'Oil Control Fluid SPF50+', form: 'lotion', category: 'skin' },
    countries: ['NG'],
    expected: { skinConcernsPlausible: ['hd_age_spot', 'hd_oiliness', 'hd_pore', 'hd_acne'], skinTypesPlausible: ['oily', 'combination'], stepsPlausible: ['protect'], frequencyPlausible: ['am', 'as-needed'], soldIn: { NG: true } },
  },
  // cerave-foaming-cleanser-oily (was cerave-foaming-facial-cleanser-normal-to-oily)
  // Why: CeraVe has a Hydrating Cleanser (normal to dry) and several Foaming/Cream-to-Foam/Foaming Oil siblings in the same shops; skin type
  // must come from the foaming gel page, not the hydrating one.
  // Trap: What the scorer enforces is that no value is cited from a page the judge says is about a different product (exactProduct 'no' fails the
  // case): a skin type, price or size taken from the Hydrating or Foaming Oil page is the failure. Whether the skin types avoid 'dry' is not enforced:
  // the plausible sets are reported as agree or disagree and never gate.
  // Evidence pages:
  //   https://www.cerave.com/skincare/cleansers/foaming-facial-cleanser
  //   https://www.cerave.co.uk/skincare/cleansers/foaming-cleanser
  //   https://gomed.ng/product/cerave-foaming-cleanser-for-normal-to-oily-skin-236ml
  //   https://gomed.ng/product/cerave-hydrating-facial-cleanser-335ml
  {
    id: 'cerave-foaming-cleanser-oily',
    kind: 'trap-sibling',
    product: { brand: 'CeraVe', name: 'Foaming Facial Cleanser', variant: 'Normal to Oily Skin', form: 'gel', category: 'skin' },
    countries: ['NG', 'GB'],
    expected: { skinConcernsPlausible: ['hd_oiliness', 'hd_pore', 'hd_acne'], skinTypesPlausible: ['oily', 'combination', 'normal'], stepsPlausible: ['cleanse'], frequencyPlausible: ['am', 'pm', 'am-pm'], soldIn: { NG: true, GB: true } },
  },
  // supergoop-unseen-sunscreen-spf40
  // Why: Popular US sunscreen. The first live run showed it is sold in Nigeria: the judge fetched Nigerian shop pages showing NGN prices, so this
  // is an ordinary case, not a foreign-currency trap (it was one while no Nigerian listing had been found).
  // Evidence of sale in Nigeria, found 2026-10-22 (the judge fetched this Nigerian shop's pages in the first live run, which showed NGN prices):
  //   https://peronabeauty.com/product/supergoop-unseen-sunscreen-broad-spectrum-spf-40-pa/
  // Other pages:
  //   https://www.refinery29.com/en-us/shop/product/unseen-sunscreen-spf-40-165365
  //   https://supergoop.com/products/unseen-sunscreen-spf-40
  {
    id: 'supergoop-unseen-sunscreen-spf40',
    kind: 'ordinary',
    product: { brand: 'Supergoop!', name: 'Unseen Sunscreen', variant: 'SPF 40', form: 'gel', category: 'skin' },
    countries: ['NG'],
    expected: { skinConcernsPlausible: ['hd_age_spot'], stepsPlausible: ['protect'], frequencyPlausible: ['am', 'as-needed'], soldIn: { NG: true } },
  },
  // black-girl-sunscreen-spf30
  // Why: Brand marketed to melanin-rich skin. The first live run showed it is sold in Nigeria: the judge fetched Nigerian shop pages showing NGN
  // prices, so this is an ordinary case, not a foreign-currency trap (it was one while no Nigerian listing had been found).
  // Evidence of sale in Nigeria, found 2026-10-22 (the judge fetched Nigerian shop pages in the first live run, which showed NGN prices):
  //   https://rhemabeautyshop.com/shop/black-girl-sunscreen-spf-30-89ml/
  //   https://tosnigeria.com/shop/black-girl-sunscreen-moisturizing-sunscreen-lotion-broad-spectrum-spf-30/
  // Other pages:
  //   https://shop.buyblack.org/products/black-girl-sunscreen-face-body-moisturizing-sunscreen-lotion-spf-30-no-white-residue-for-melanin-rich-skin-2-fl-oz
  //   https://blackgirlsunscreen.com/product/black-girl-sunscreen-spf-30/
  //   https://glamglobal.co.uk/products/black-girl-sunscreen-broad-spectrum-spf-30-59ml-x-2-no-white-cast-sunscreen-for-melanin-rich-skin
  {
    id: 'black-girl-sunscreen-spf30',
    kind: 'ordinary',
    product: { brand: 'Black Girl Sunscreen', name: 'Face & Body Moisturizing Sunscreen Lotion', variant: 'SPF 30', form: 'lotion', category: 'skin' },
    countries: ['NG'],
    expected: { skinConcernsPlausible: ['hd_age_spot'], skinTypesPlausible: ['all'], stepsPlausible: ['protect'], frequencyPlausible: ['am', 'as-needed'], soldIn: { NG: true } },
  },
  // unbranded-mama-adaeze-shea (was unbranded-mama-adaeze-pure-shea-butter)
  // Why: Deliberately made-up brand-ish name for a generic market product; a searched exact-phrase query found no such product, only unrelated
  // shea brands and generic articles.
  // Trap: Draft nothing: no concerns, skin types, steps, frequency, prices or retailers. Generic shea butter articles or other brands' pages
  // (for example Aviela, Eu'Genia, Mama Aua) must not be attributed to this product.
  {
    id: 'unbranded-mama-adaeze-shea',
    kind: 'trap-unbranded',
    product: { brand: 'Mama Adaeze', name: 'Pure Shea Butter', form: 'balm', category: 'skin' },
    countries: ['NG'],
    expected: { soldIn: { NG: 'unknown' } },
  },
  // dettol-antiseptic-liquid-original
  // Why: Real, heavily stocked in Nigerian pharmacies, but it is a first-aid and household disinfectant diluted before use, not a skincare
  // routine product; tests that the drafter does not invent concerns, a routine step or frequency.
  // Trap: Empty lists mean leave empty: no HD skin concern, no cleanse/treat/moisturise/protect step, no routine frequency and no skin type,
  // because the product is an antiseptic/disinfectant to be diluted. An availability row for NG (retailer and price) is acceptable but nothing
  // routine-related.
  // The scorer allows that: a trap-not-skincare case fails only on a drafted skincare cell (concerns, skin types, steps or frequency); its ingredient list and price rows are judged like any value.
  // Evidence pages:
  //   https://wellness.gomed.ng/product/dettol-liquid-250ml
  {
    id: 'dettol-antiseptic-liquid-original',
    kind: 'trap-not-skincare',
    product: { brand: 'Dettol', name: 'Antiseptic Liquid', variant: 'Original', form: 'liquid', category: 'skin' },
    countries: ['NG'],
    expected: { soldIn: { NG: true } },
  },
]

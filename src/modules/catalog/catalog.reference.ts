// This is a SEED list, hand-compiled, not the full EU CosIng annexes. A proper import from the public CosIng
// export is a follow-up, and until then a clean result here does not mean an ingredient is permitted or safe.
//
// What it holds today: the original 26 labelled fragrance allergens (the two now banned are listed as banned),
// the banned substances the product scan most needs to catch, and a handful of commonly cited sun-sensitising,
// pore-clogging, irritating and pregnancy-caution ingredients. It holds NO entries yet for restricted
// substances (limits and conditions of use), interactions, or drying.
//
// The EU's labelled-allergen list was expanded by Regulation (EU) 2023/1545 (about 80 substances), so the
// allergen set here is partial.
//
// Alias coverage is hand-built: the names and spellings below are the ones someone thought of, so a real label
// can still use a synonym that is missing. Matching is exact on the normalised name or alias (ingredientParts
// also tries the parts of "Aqua (Water)", "A/B" and "Hydroquinone 4%"), never fuzzy, so nothing is flagged by resemblance.
//
// Every kind except banned-substance and the named fragrance allergens is a commonly cited concern, not a
// regulatory listing (undisclosed `parfum` included): its `rule` says so and its `source` is null, so a
// regulation URL is never shown as backing something no regulation says.
//
// Names and aliases are stored normalised (normaliseIngredient(x) === x). An entry has one kind; an
// ingredient with two concerns has two entries.
import type { ConcernKind } from './catalog.vocabulary'

/** Bumped whenever an entry is added, changed or removed, so analyses made against older data can be found. */
export const REFERENCE_VERSION = 'seed-2026-10'

/**
 * How much of the regulatory lists this data covers. Always 'partial' until the full CosIng import lands. The
 * catalog service must carry it to users, so a result with no flags never reads as an all-clear.
 */
export const REFERENCE_COVERAGE = 'partial'

export type ReferenceEntry = {
  /** Normalised INCI name. */
  name: string
  /** Other normalised spellings that mean the same thing. */
  aliases: string[]
  kind: ConcernKind
  /** Plain-English statement of the concern, passed to the analyst as a fact it must explain. */
  rule: string
  /** https URL of the regulation behind a regulatory entry; null for a commonly cited concern. */
  source: string | null
}

const EUR_LEX = 'https://eur-lex.europa.eu/eli/reg/2009/1223/oj'

export const REFERENCE: readonly ReferenceEntry[] = [
  {
    name: 'mercury',
    aliases: ['mercuric chloride', 'mercury chloride', 'mercuric iodide', 'mercury iodide', 'mercuric oxide', 'mercury oxide', 'mercurous iodide'],
    kind: 'banned-substance',
    rule:
      'Mercury and its compounds are prohibited in cosmetics in the EU (Annex II to Regulation (EC) No 1223/2009), apart from a narrow preservative exception for some eye products. Mercury in skin-lightening products is a known poisoning risk.',
    source: EUR_LEX,
  },
  {
    name: 'mercurous chloride',
    aliases: ['calomel'],
    kind: 'banned-substance',
    rule:
      'A mercury compound (also called calomel), prohibited in cosmetics in the EU (Annex II to Regulation (EC) No 1223/2009). Mercury in skin-lightening products is a known poisoning risk.',
    source: EUR_LEX,
  },
  {
    name: 'ammoniated mercury',
    aliases: ['mercuric ammonium chloride', 'mercury amide chloride'],
    kind: 'banned-substance',
    rule:
      'A mercury compound, prohibited in cosmetics in the EU (Annex II to Regulation (EC) No 1223/2009). Mercury in skin-lightening products is a known poisoning risk.',
    source: EUR_LEX,
  },
  {
    name: 'hydroquinone',
    aliases: ['1,4-dihydroxybenzene', 'quinol'],
    kind: 'banned-substance',
    rule:
      'Not permitted in cosmetic skin products in the EU; the only permitted cosmetic use is in professional artificial nail systems at a very low concentration. It is sometimes found in skin-lightening products.',
    source: EUR_LEX,
  },
  {
    name: 'clobetasol propionate',
    aliases: ['clobetasol', 'clobetasol 17-propionate'],
    kind: 'banned-substance',
    rule:
      'A prescription corticosteroid, not permitted as a cosmetic ingredient. A product listing it is a medicine or an illegal skin-lightening product.',
    source: EUR_LEX,
  },
  {
    name: 'tretinoin',
    aliases: ['retinoic acid'],
    kind: 'banned-substance',
    rule:
      'Tretinoin (retinoic acid) is a prescription retinoid medicine. It is not permitted in cosmetics in the EU (Annex II to Regulation (EC) No 1223/2009).',
    source: EUR_LEX,
  },
  {
    name: 'butylphenyl methylpropional',
    aliases: ['lilial'],
    kind: 'banned-substance',
    rule:
      'Also called lilial. Classed as toxic to reproduction and banned in cosmetics in the EU from 2022 (Annex II to Regulation (EC) No 1223/2009). It was on the original labelled fragrance allergen list.',
    source: EUR_LEX,
  },
  {
    name: 'hydroxyisohexyl 3-cyclohexene carboxaldehyde',
    aliases: ['lyral', 'hicc', 'hydroxymethylpentylcyclohexenecarboxaldehyde'],
    kind: 'banned-substance',
    rule:
      'Also called lyral (HICC). A strong skin sensitiser, banned in cosmetics in the EU from 2021 (Annex II to Regulation (EC) No 1223/2009). It was on the original labelled fragrance allergen list.',
    source: EUR_LEX,
  },
  {
    name: 'amyl cinnamal',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'amylcinnamyl alcohol',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'anise alcohol',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'benzyl alcohol',
    aliases: [],
    kind: 'allergen',
    rule:
      'Mostly used as a preservative and solvent; also one of the fragrance allergens the EU requires to be named on the label above set concentrations.',
    source: EUR_LEX,
  },
  {
    name: 'benzyl benzoate',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'benzyl cinnamate',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'benzyl salicylate',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'cinnamal',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'cinnamyl alcohol',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'citral',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'citronellol',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'coumarin',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'evernia furfuracea extract',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'evernia prunastri extract',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'eugenol',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'farnesol',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'geraniol',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'hexyl cinnamal',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'hydroxycitronellal',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'isoeugenol',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'limonene',
    aliases: ['d-limonene'],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'linalool',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'methyl 2-octynoate',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'alpha-isomethyl ionone',
    aliases: [],
    kind: 'allergen',
    rule:
      'A fragrance ingredient the EU requires to be named on the label when it passes a set level (Annex III to Regulation (EC) No 1223/2009) because it can cause contact allergy in sensitive people.',
    source: EUR_LEX,
  },
  {
    name: 'parfum',
    aliases: ['fragrance'],
    kind: 'allergen',
    rule:
      'Fragrance can be a mix of many ingredients that the label does not have to name one by one, including labelled fragrance allergens. A commonly cited concern for fragrance-sensitive skin, not a regulatory listing.',
    source: null,
  },
  {
    name: 'glycolic acid',
    aliases: [],
    kind: 'sun-sensitivity',
    rule:
      'An alpha hydroxy acid. These can make skin more sensitive to the sun, so sunscreen is advised. A commonly cited concern (FDA guidance), not a regulatory listing.',
    source: null,
  },
  {
    name: 'lactic acid',
    aliases: [],
    kind: 'sun-sensitivity',
    rule:
      'An alpha hydroxy acid. These can make skin more sensitive to the sun, so sunscreen is advised. A commonly cited concern (FDA guidance), not a regulatory listing.',
    source: null,
  },
  {
    name: 'retinol',
    aliases: [],
    kind: 'sun-sensitivity',
    rule:
      'Retinoids can make skin more sensitive to the sun, so sunscreen is advised. A commonly cited concern, not a regulatory listing.',
    source: null,
  },
  {
    name: 'retinal',
    aliases: ['retinaldehyde'],
    kind: 'sun-sensitivity',
    rule:
      'A retinoid. Retinoids can make skin more sensitive to the sun, so sunscreen is advised. A commonly cited concern, not a regulatory listing.',
    source: null,
  },
  {
    name: 'citrus aurantium bergamia peel oil',
    aliases: ['citrus aurantium bergamia (bergamot) peel oil', 'citrus aurantium bergamia (bergamot) fruit oil', 'bergamot oil'],
    kind: 'sun-sensitivity',
    rule:
      'Bergamot oil contains furocoumarins that can cause a skin reaction in sunlight (phototoxicity). A commonly cited concern, not a regulatory listing.',
    source: null,
  },
  {
    name: 'retinol',
    aliases: [],
    kind: 'pregnancy-caution',
    rule:
      'Retinoids are commonly advised against during pregnancy as a precaution. A commonly cited concern, not a regulatory listing.',
    source: null,
  },
  {
    name: 'retinal',
    aliases: ['retinaldehyde'],
    kind: 'pregnancy-caution',
    rule:
      'A retinoid. Retinoids are commonly advised against during pregnancy as a precaution. A commonly cited concern, not a regulatory listing.',
    source: null,
  },
  {
    name: 'hydroquinone',
    aliases: ['1,4-dihydroxybenzene', 'quinol'],
    kind: 'pregnancy-caution',
    rule:
      'Hydroquinone is commonly advised against during pregnancy because a notable share of it is absorbed through the skin. A commonly cited concern, not a regulatory listing.',
    source: null,
  },
  {
    name: 'isopropyl myristate',
    aliases: [],
    kind: 'pore-clogging',
    rule:
      'Rich oils, butters and esters that are commonly cited as pore-clogging (comedogenic) for acne-prone skin. A commonly cited concern, not a regulatory listing.',
    source: null,
  },
  {
    name: 'isopropyl palmitate',
    aliases: [],
    kind: 'pore-clogging',
    rule:
      'Rich oils, butters and esters that are commonly cited as pore-clogging (comedogenic) for acne-prone skin. A commonly cited concern, not a regulatory listing.',
    source: null,
  },
  {
    name: 'cocos nucifera oil',
    aliases: ['coconut oil'],
    kind: 'pore-clogging',
    rule:
      'Rich oils, butters and esters that are commonly cited as pore-clogging (comedogenic) for acne-prone skin. A commonly cited concern, not a regulatory listing.',
    source: null,
  },
  {
    name: 'theobroma cacao seed butter',
    aliases: ['cocoa butter'],
    kind: 'pore-clogging',
    rule:
      'Rich oils, butters and esters that are commonly cited as pore-clogging (comedogenic) for acne-prone skin. A commonly cited concern, not a regulatory listing.',
    source: null,
  },
  {
    name: 'sodium lauryl sulfate',
    aliases: [],
    kind: 'irritation',
    rule:
      'A strong cleansing agent that is commonly cited as irritating to sensitive or dry skin. A commonly cited concern, not a regulatory listing.',
    source: null,
  },
  {
    name: 'alcohol denat',
    aliases: ['denatured alcohol'],
    kind: 'irritation',
    rule:
      'Denatured alcohol can sting and dry out sensitive skin, especially high in the list. A commonly cited concern, not a regulatory listing.',
    source: null,
  },
]

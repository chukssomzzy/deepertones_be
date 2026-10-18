import type { DraftConcern } from '../../providers/product-analysis/product-analyst.provider'
import type { NoLabelPurpose, NoLabelSource, NoLabelUsedFor } from './scans.vocabulary'

// What to tell someone about a product with no label to read: a fixed table of rules over the three things they say about it. Pure by
// design (no I/O, no clock, no model), so the same answers always give the same words, and nothing the user types can reach the text.
//
// The concerns are written the way the analysis path writes them, so they show the same way. They have no `sources`: there is no label
// whose ingredients a regulatory listing could be matched to.

/** Bumped when the rules or their wording change. An item's cautions are worked out each time it is shown, not stored, so an older item shows the new rules at once; this tells a client which rules wrote what it is showing. */
export const CAUTION_RULES_VERSION = 1

export type NoLabelAnswers = { source: NoLabelSource; purpose: NoLabelPurpose; usedFor: NoLabelUsedFor }

const LONG_USE: readonly NoLabelUsedFor[] = ['6-months-2-years', 'over-2-years']
// A market stall or an unknown source is where an unlisted lightener most often turns up, so these get the stronger words.
const LESS_TRUSTED_SOURCES: readonly NoLabelSource[] = ['market-vendor', 'not-sure']

// What each substance does, said separately: they do not share their harms. Many countries do not allow them in cosmetics.
const LIGHTENER_HARMS =
  'Many countries do not allow these in cosmetics. Mercury can damage the kidneys and nerves, strong steroids can thin the skin and cause stretch marks and acne, ' +
  'and high-dose hydroquinone can cause dark blue-black patches (ochronosis).'

const LIGHTENER_WHO =
  'Anyone who is pregnant or breastfeeding, children, and people with kidney problems should not use a product like this. ' +
  'Stop using it and ask a pharmacist or doctor if the skin thins, burns, breaks out or darkens in patches, or if you feel unwell.'

// Each concern is built fresh on every call, so a caller that edits one cannot change the next result.
const lightener = (source: NoLabelSource): DraftConcern => ({
  kind: 'banned-substance',
  severity: 'high',
  ingredients: ['mercury', 'hydroquinone', 'corticosteroids'],
  why: LESS_TRUSTED_SOURCES.includes(source)
    ? 'Skin-lightening creams with no label, especially ones from market stalls or from a source nobody can confirm, have sometimes been found to contain mercury, hydroquinone or strong steroids (corticosteroids). ' +
      LIGHTENER_HARMS +
      ' With no ingredient list we cannot tell whether this product has any of them, so it is safest to treat it as if it might.'
    : 'A skin-lightening product with no label can still contain mercury, hydroquinone or strong steroids (corticosteroids). ' +
      LIGHTENER_HARMS +
      ' Where it came from may make this less likely, but it does not rule it out, and with no ingredient list we cannot check.',
  whoShouldTakeCare: LIGHTENER_WHO,
  traits: ['pregnancy'],
  sources: [],
})

const longUse = (): DraftConcern => ({
  kind: 'hyperpigmentation-risk',
  severity: 'medium',
  ingredients: [],
  why:
    'Strong lightening or spot-treating products used for many months or years can thin the skin, making it bruise, tear and sunburn more easily. ' +
    'Some can also make the skin darken in blue-black patches (ochronosis), which can be slow or hard to reverse. ' +
    'Because this product has no label, we cannot tell whether it is one of them.',
  whoShouldTakeCare:
    'Anyone who has used a lightening or spot-treating product for more than 6 months. ' +
    'Look for thin, shiny or easily bruised skin, stretch marks, or new dark patches, and ask a pharmacist, doctor or dermatologist if you notice any. Sunscreen helps protect thinned skin.',
  traits: ['dark-spots'],
  sources: [],
})

const unknownContents = (): DraftConcern => ({
  kind: 'irritation',
  severity: 'medium',
  ingredients: [],
  why:
    'The contents of this product are unknown, because there is no label to read. Any product can irritate the skin or cause an allergic reaction, ' +
    'and with the ingredients unknown we cannot check for the ones that are most likely to.',
  whoShouldTakeCare:
    'Treat it with caution. Patch-test first: put a small amount on the inner forearm, wait 24 hours, and do not use it if you see redness, itching, burning or swelling. ' +
    'A patch test only shows a quick skin reaction; it cannot show whether a product is safe to keep using. ' +
    'Keep it away from broken skin, eyes and mouth, and take extra care if you are pregnant or if it is for a child.',
  traits: ['sensitive'],
  sources: [],
})

/** The concerns for these answers, in a fixed order: the banned substances, then long use, then the caution every product with no label gets. Any `description` the caller holds is not an input. */
export const cautionFor = ({ source, purpose, usedFor }: NoLabelAnswers): DraftConcern[] => [
  ...(purpose === 'lighten' ? [lightener(source)] : []),
  ...((purpose === 'lighten' || purpose === 'treat-spots') && LONG_USE.includes(usedFor) ? [longUse()] : []),
  unknownContents(),
]

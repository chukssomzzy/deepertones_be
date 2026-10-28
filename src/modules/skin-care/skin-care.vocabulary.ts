/** What a person can say they are noticing on a skin log. Choose any, except `nothing-unusual`, which only ever stands alone. */
export const NOTICING = ['stinging-or-burning', 'new-redness', 'tightness-or-dryness', 'new-breakouts', 'itching', 'swelling', 'nothing-unusual', 'pus-or-hot-patch'] as const
export type Noticing = (typeof NOTICING)[number]

/** Where on the face. Choose any. */
export const WHERE = ['cheeks', 'nose', 'forehead', 'neck', 'chin-and-jaw', 'near-eyes', 'everywhere'] as const
export type Where = (typeof WHERE)[number]

/** How bad it is: one choice, mildest first. */
export const HOW_BAD = ['mild', 'noticeable', 'hard-to-ignore'] as const
export type HowBad = (typeof HOW_BAD)[number]

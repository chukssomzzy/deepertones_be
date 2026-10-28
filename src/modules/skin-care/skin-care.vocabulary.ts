/** What a person can say they are noticing on a skin log. Choose any, except `nothing-unusual`, which only ever stands alone. */
export const NOTICING = ['stinging-or-burning', 'new-redness', 'tightness-or-dryness', 'new-breakouts', 'itching', 'swelling', 'nothing-unusual', 'pus-or-hot-patch'] as const
export type Noticing = (typeof NOTICING)[number]

/** Where on the face. Choose any. */
export const WHERE = ['cheeks', 'nose', 'forehead', 'neck', 'chin-and-jaw', 'near-eyes', 'everywhere'] as const
export type Where = (typeof WHERE)[number]

/** How bad it is: one choice, mildest first. */
export const HOW_BAD = ['mild', 'noticeable', 'hard-to-ignore'] as const
export type HowBad = (typeof HOW_BAD)[number]

/** The product a stored routine step names, restated here so skin-care does not import routines: a shelf entry, a recommended product by code, or "use what you have". */
export type SkinCareProductRef = { kind: 'shelf'; id: string } | { kind: 'candidate'; code: string } | { kind: 'none' }

/** Where a pause is. `paused` and `bringing-back` are open (they hold their step); `ended`, `replaced` (the step's product changed) and `undone` are closed. */
export const PAUSE_STATES = ['paused', 'bringing-back', 'ended', 'replaced', 'undone'] as const
export type PauseState = (typeof PAUSE_STATES)[number]

/** How an escalation hold ends: `seen` (the person says they saw a professional) or `settled` (the skin has settled). */
export const HOLD_CLOSE_HOW = ['seen', 'settled'] as const
export type HoldCloseHow = (typeof HOLD_CLOSE_HOW)[number]

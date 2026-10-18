// What a person can tick on the safety question, in the order the app shows them. This order is also the canonical one the service stores and
// returns the choices in. "none" stands alone: it says that none of the other four apply.
export const SAFETY_CHOICES = ['pregnant', 'breastfeeding', 'reaction', 'prescription', 'none'] as const

export type SafetyChoice = (typeof SAFETY_CHOICES)[number]

/** The most characters either detail field takes, once trimmed. */
export const SAFETY_TEXT_MAX = 300

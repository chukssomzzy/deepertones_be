// Words a routine must never use (CONTEXT.md, Safety). A starter list the owner will refine; keep it in this one constant.
// Every pattern is case-insensitive and word-bounded, and none is global or sticky: a RegExp with those flags keeps a lastIndex
// between calls, so the same text would pass the second time it is checked.

// The condition words behind two of the groups below, so the name list and the "you have <condition>" phrasing cannot drift apart.
// A bare "infection" is not here: safety advice ("if you see signs of infection, stop and see a pharmacist") must pass. It is only
// caught as a diagnosis ("you have an infection") or as "fungal infection". PIH and TSW are blocked too, although CONTEXT.md lets
// the app say "the pattern usually called PIH" in a few fixed places: a routine's reasons stay plainer than that.
const CONDITION_NAMES =
  'melasma|rosacea|eczema|dermatitis|psoriasis|vitiligo|keloids?|folliculitis|pseudofolliculitis|seborrh(?:o)?e(?:ic|a)|tinea|ringworm|fungal infections?|acne vulgaris|post[- ]inflammatory hyperpigmentation|PIH|topical steroid withdrawal|TSW'

// What follows "lighter <skin|face|...>" when it is texture or product advice ("a lighter face cream", "lighter skin care"), not the person.
const PRODUCT_WORDS = 'cream|creams|wash|cleanser|lotion|gel|serum|moisturi[sz]er|sunscreen|spf|texture|formula|matching|care|products?'
// What follows "7/10" or "8 out of 10" when it is a dose or a wait ("1/10 of a teaspoon", "5/10 minutes"), not a score.
const DOSE_WORDS = 'of|minutes?|mins?|seconds?|secs?|hours?|hrs?|days?|weeks?|months?|ml|mg|g|tsp|tbsp|teaspoons?|tablespoons?|pumps?|drops?|inch|inches|cm|mm|times?|%'

export const FORBIDDEN_WORDING: readonly { code: string; pattern: RegExp }[] = [
  // We never diagnose or name a condition: only a clinician does. Words are bounded so "disinfection" and "pith" stay clear.
  { code: 'condition-name', pattern: new RegExp(`\\b(?:${CONDITION_NAMES})\\b`, 'i') },

  // Diagnosis phrasing says the person has something, which is a diagnosis whatever the condition. "Use what you have" and
  // "the products you have" are plain advice and must pass, so "you have" is only caught when a condition or a condition noun follows.
  { code: 'you-have-condition', pattern: new RegExp(`\\byou\\s+have\\s+(?:(?:an?\\s+(?:condition|disease|disorder|infection))|infections?|${CONDITION_NAMES})\\b`, 'i') },
  { code: 'you-suffer-from', pattern: /\byou\s+suffer\s+from\b/i },
  { code: 'diagnos', pattern: /\bdiagnos\w*/i },

  // Lightness is never a result we promise or a thing we aim for (the goal is an even, brighter look). "Lightening cream" is a
  // product someone is stopping, and "brighter" is a goal, so neither is caught. "Lighter" is only the person when it is not about
// texture ("a lighter face cream"), and fading dark marks ("lightens the tone of dark marks") is a goal, not a change of the person.
  { code: 'lighter-skin', pattern: new RegExp(`\\blighter[\\s-]+(?:skin|face|complexion|tone)\\b(?![\\s-]+(?:${PRODUCT_WORDS})\\b)`, 'i') },
  { code: 'skin-will-be-lighter', pattern: /\b(?:skin|face|complexion)\s+(?:will\s+(?:be|get|become|look)|looks?|gets?|becomes?|turns?)(?:\s+(?:much|visibly|noticeably|a\s+lot))?\s+lighter\b/i },
  { code: 'lightening-skin', pattern: /\blighten(?:s|ed|ing)?[\s-]+(?:your|the)[\s-]+(?:skin|face|complexion)\b/i },
  { code: 'skin-lightening', pattern: /\bskin[\s-]+lighten(?:s|ed|ing)?\b(?![\s-]+(?:creams?|products?|lotions?|soaps?|serums?|gels?)\b)/i },
  { code: 'fairer', pattern: /\bfair[\s-]*er\b/i },
  { code: 'whiter', pattern: /\bwhiter\b/i },
  { code: 'whitening', pattern: /\bwhiten(?:s|ing)?\b/i },
  { code: 'skin-bleaching', pattern: /\bskin[\s-]+bleaching\b/i },

  // We never grade or score a person's skin. Ingredient strengths ("10% niacinamide") are not scores, so only "n/10", "n out of 10"
  // (or 100) and "grade" said about the person are caught.
  { code: 'skin-score', pattern: /\bskin\s+score\b/i },
  { code: 'score-out-of', pattern: new RegExp(`\\b\\d+(?:\\.\\d+)?\\s*/\\s*(?:10|100)\\b(?![\\s-]*(?:${DOSE_WORDS})(?![a-z]))`, 'i') },
  { code: 'out-of-ten', pattern: new RegExp(`\\b\\d+(?:\\.\\d+)?\\s+(?:out\\s+of|outta)\\s+(?:10|100|ten|hundred)\\b(?![\\s-]*(?:${DOSE_WORDS})(?![a-z]))`, 'i') },
  { code: 'skin-grade', pattern: /\byour\s+(?:skin\s+)?grade\b|\bgrad(?:e|es|ed|ing)\s+your\b|\bgraded\b/i },
]

import type { Goal } from './goals.vocabulary'

// DRAFT copy — needs owner/qualified review before launch (issue #82).
//
// What the app says back when someone states a goal: how long it takes, what helps and what gets in the way. It is a fixed table, not
// written by a model, so the words change only with a deploy and later screens can quote the same text. Voice (CONTEXT.md, "Tone"):
// calm, plain and direct; honest about timelines; hopeful about the goal; never a scold, a score or a comment on the person's worth;
// no brand or product names; nothing that diagnoses or promises a result, and no promise to lighten.
//
// Bump GOAL_ANSWERS_VERSION whenever the MEANING of any text here changes (a different timeline, a different claim), so a client
// can tell which copy it is showing. A typo or a polish of the same meaning does not need a bump.

export const GOAL_ANSWERS_VERSION = 1

export type GoalAnswer = {
  title: string
  howLong: string
  helps: string
  inTheWay: string
  /** The one warm line about natural colour; only for someone who asked to be lighter, otherwise null. */
  note: string | null
}

type Plan = Omit<GoalAnswer, 'note'>

const PLANS: Record<Goal, Plan> = {
  'clear-skin': {
    title: 'Clearer skin',
    howLong:
      'Clearing varies from person to person. A first change often shows after 6 to 8 weeks, and a steady difference by about 12. The marks that breakouts leave behind take a few months to fade.',
    helps:
      'A gentle cleanser, a light moisturiser and sun protection, used the same way each day. Fewer products, not more, is usually what lets skin calm down.',
    inTheWay:
      'Scrubbing, picking, shaving over irritated skin, and layering several strong products at once. We\'ll check which of these apply to you.',
  },
  'even-tone': {
    title: 'Even skin tone',
    howLong:
      'Tone changes slowly. The first few weeks are about calming the skin down, and most people see a steady difference after 8 to 12 weeks.',
    helps:
      'Sun protection every day, even when it is cloudy, and a gentle routine that does not irritate. Skin evens out as it renews itself, and sun protection keeps that work from being undone.',
    inTheWay:
      'Sun without protection, picking at spots, and products that sting or leave the skin red. Every bout of irritation can leave a new dark patch behind, so calm skin matters more than strong products.',
  },
  'fade-dark-marks': {
    title: 'Fading dark marks',
    howLong:
      'Dark marks fade slowly, and it takes months. Many people see a first change after 8 to 12 weeks, and older or deeper marks can take six months or more.',
    helps:
      'Sun protection every day comes first, because sun makes marks darker again. Then a gentle routine that leaves the skin alone, so no new marks form while the old ones fade.',
    inTheWay:
      'Sun without protection undoes progress quickly. So does picking or scrubbing at marks, and using strong products that irritate the skin, which can add new marks. We\'ll check what you use now.',
  },
  brighter: {
    title: 'Brighter, more even skin',
    howLong:
      'Skin looks brighter as dark marks fade and dullness lifts, and that takes time. Expect a few weeks of calming the skin down first, then a steady change over 8 to 12 weeks.',
    helps:
      'Sun protection every day, gentle cleansing, and a short routine that keeps the skin calm and moisturised. Healthy, even skin reflects more light.',
    inTheWay:
      'Sun without protection, harsh or irritating products, and anything that thins the skin. Some products promise quick results, then leave skin thinner or redder; we\'ll check yours.',
  },
  glow: {
    title: 'A healthy glow',
    howLong:
      'Calm, moisturised skin can start to look healthier within a few weeks, and it takes the same simple routine every day to keep it. If your skin is irritated now, calming it comes first.',
    helps:
      'Gentle cleansing, a moisturiser that suits your skin, and sun protection every day. Healthy skin reflects light on its own, without anything added to make it shine.',
    inTheWay:
      'Over-cleansing and scrubbing, which strip the skin and leave it looking dull, and skipping sun protection.',
  },
}

// One note whichever goal the person was sorted into: what they asked for gets a real routine, and the one honest thing is said once.
const COLOUR_NOTE =
  'We\'ll build you a routine for brighter, more even skin. One honest thing: no safe product changes your natural colour, and we won\'t suggest anything that tries.'

/** The answer for a goal. `wantsLighter` adds the colour note and changes nothing else. */
export const answerFor = (goal: Goal, wantsLighter: boolean): GoalAnswer => ({ ...PLANS[goal], note: wantsLighter ? COLOUR_NOTE : null })

import { describe, expect, it } from 'vitest'
import { SKIN_OUTCOME_RULES_VERSION, type SkinOutcome, outcomeFor } from './skin-care.outcomes'

// The fixed rules that decide what a skin log comes to (spec #233, PR 2). Pure: no clock, no I/O, and nothing from the note. The expected values below are the
// owner's rules written out as data (never recomputed by a second copy of the rule), so a wrong rule in the code disagrees with them.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the function and its result, not the file or the input type):
//   src/modules/skin-care/skin-care.outcomes.ts exports
//     outcomeFor(log: { noticing: Noticing[]; where: Where[]; howBad: HowBad | null }, context: { stepDownRunning: boolean }): SkinOutcome
//     SKIN_OUTCOME_RULES_VERSION   stored on every log, so a later change of the rules can tell which version decided an old one
//     SkinOutcome = { kind: 'professional'; reason } | { kind: 'pause'; duringStepDown: boolean } | { kind: 'expected-flare' } | { kind: 'advice'; codes: ResponseOutcome[] } | { kind: 'logged' }
//   `noticing` is already validated (non-empty, no duplicates, `nothing-unusual` only ever alone, `howBad` null only for that); the service does that, not this function.
//   Precedence: professional, then pause, then expected-flare, then advice, then logged.
//   professional's reason, the first that applies: pus-or-hot-patch, swelling, near-eyes (any near-eyes in `where`).
//   pause: stinging-or-burning or new-redness at any howBad, or ANY symptom at hard-to-ignore. During a running step-down a pause that comes only from stinging, burning or
//     new redness at mild or noticeable is expected-flare instead; hard-to-ignore stays a pause, marked duringStepDown: true.
//   advice: tightness-or-dryness, itching, new-breakouts at mild or noticeable; codes in the order advice-tightness, advice-itching, advice-breakouts whatever order they were logged in.
//   logged: only nothing-unusual.

type Noticing = Parameters<typeof outcomeFor>[0]['noticing'][number]
type Where = Parameters<typeof outcomeFor>[0]['where'][number]
type HowBad = NonNullable<Parameters<typeof outcomeFor>[0]['howBad']>

const WHERE: Where[] = ['cheeks', 'nose', 'forehead', 'neck', 'chin-and-jaw', 'near-eyes', 'everywhere']
const HOW_BAD: HowBad[] = ['mild', 'noticeable', 'hard-to-ignore']
const SYMPTOMS: Noticing[] = ['stinging-or-burning', 'new-redness', 'tightness-or-dryness', 'new-breakouts', 'itching', 'swelling', 'pus-or-hot-patch']

const decide = (noticing: Noticing[], howBad: HowBad | null, over: { where?: Where[]; stepDown?: boolean } = {}): SkinOutcome =>
  outcomeFor({ noticing, where: over.where ?? [], howBad }, { stepDownRunning: over.stepDown ?? false })

const PAUSE: SkinOutcome = { kind: 'pause', duringStepDown: false }
const PAUSE_DURING_STEP_DOWN: SkinOutcome = { kind: 'pause', duringStepDown: true }
const FLARE: SkinOutcome = { kind: 'expected-flare' }
const LOGGED: SkinOutcome = { kind: 'logged' }
const professional = (reason: 'pus-or-hot-patch' | 'swelling' | 'near-eyes'): SkinOutcome => ({ kind: 'professional', reason })
const advice = (...codes: ('advice-tightness' | 'advice-itching' | 'advice-breakouts')[]): SkinOutcome => ({ kind: 'advice', codes })

// One symptom on its own, at each of the three levels: [mild, noticeable, hard-to-ignore], with no step-down running.
const ALONE: Record<Noticing, [SkinOutcome, SkinOutcome, SkinOutcome]> = {
  'stinging-or-burning': [PAUSE, PAUSE, PAUSE],
  'new-redness': [PAUSE, PAUSE, PAUSE],
  'tightness-or-dryness': [advice('advice-tightness'), advice('advice-tightness'), PAUSE],
  'new-breakouts': [advice('advice-breakouts'), advice('advice-breakouts'), PAUSE],
  itching: [advice('advice-itching'), advice('advice-itching'), PAUSE],
  swelling: [professional('swelling'), professional('swelling'), professional('swelling')],
  'pus-or-hot-patch': [professional('pus-or-hot-patch'), professional('pus-or-hot-patch'), professional('pus-or-hot-patch')],
  'nothing-unusual': [LOGGED, LOGGED, LOGGED],
}

// The same, while a step-down is running: only the two harm signals at mild or noticeable change (to the expected flare), and hard-to-ignore pauses are marked.
const ALONE_DURING_STEP_DOWN: Record<Noticing, [SkinOutcome, SkinOutcome, SkinOutcome]> = {
  ...ALONE,
  'stinging-or-burning': [FLARE, FLARE, PAUSE_DURING_STEP_DOWN],
  'new-redness': [FLARE, FLARE, PAUSE_DURING_STEP_DOWN],
  'tightness-or-dryness': [advice('advice-tightness'), advice('advice-tightness'), PAUSE_DURING_STEP_DOWN],
  'new-breakouts': [advice('advice-breakouts'), advice('advice-breakouts'), PAUSE_DURING_STEP_DOWN],
  itching: [advice('advice-itching'), advice('advice-itching'), PAUSE_DURING_STEP_DOWN],
}

describe('SKIN_OUTCOME_RULES_VERSION', () => {
  it('is set, so every stored log can say which rules decided it', () => {
    expect(SKIN_OUTCOME_RULES_VERSION).toBeTruthy()
  })
})

describe('outcomeFor, one symptom on its own', () => {
  for (const [symptom, expected] of Object.entries(ALONE) as [Noticing, SkinOutcome[]][]) {
    for (const [index, howBad] of (symptom === 'nothing-unusual' ? [null] : HOW_BAD).entries()) {
      it(`${symptom} at ${howBad ?? 'no level'} comes to ${expected[index]!.kind}${'codes' in expected[index]! ? ` ${expected[index]!.codes.join(', ')}` : ''}`, () => {
        expect(decide([symptom], howBad)).toEqual(expected[index])
      })
    }
  }

  it('does not turn nothing-unusual into a pause, whatever level came with it (it is not a symptom)', () => {
    for (const howBad of HOW_BAD) expect(decide(['nothing-unusual'], howBad)).toEqual(LOGGED)
  })
})

describe('outcomeFor, one symptom while a step-down is running', () => {
  for (const [symptom, expected] of Object.entries(ALONE_DURING_STEP_DOWN) as [Noticing, SkinOutcome[]][]) {
    for (const [index, howBad] of (symptom === 'nothing-unusual' ? [null] : HOW_BAD).entries()) {
      it(`${symptom} at ${howBad ?? 'no level'} comes to ${expected[index]!.kind}${'duringStepDown' in expected[index]! ? ` (duringStepDown ${expected[index]!.duringStepDown})` : ''}`, () => {
        expect(decide([symptom], howBad, { stepDown: true })).toEqual(expected[index])
      })
    }
  }
})

describe('outcomeFor, where on the face', () => {
  // Nothing but near-eyes changes an outcome: every other place leaves the table's answer as it is, and near-eyes sends anything to a professional
  // except what already is one (whose own reason comes first).
  for (const where of WHERE) {
    for (const symptom of SYMPTOMS) {
      for (const [index, howBad] of HOW_BAD.entries()) {
        const alone = ALONE[symptom][index]!
        const expected = where === 'near-eyes' && alone.kind !== 'professional' ? professional('near-eyes') : alone
        it(`${symptom} at ${howBad} on ${where} comes to ${expected.kind}${'reason' in expected ? ` (${expected.reason})` : ''}`, () => {
          expect(decide([symptom], howBad, { where: [where] })).toEqual(expected)
        })
      }
    }
  }

  it('sends near-eyes to a professional while a step-down is running too', () => {
    expect(decide(['stinging-or-burning'], 'mild', { where: ['near-eyes'], stepDown: true })).toEqual(professional('near-eyes'))
    expect(decide(['stinging-or-burning'], 'hard-to-ignore', { where: ['near-eyes'], stepDown: true })).toEqual(professional('near-eyes'))
  })

  it('sends near-eyes to a professional when it is one of several places', () => {
    expect(decide(['itching'], 'mild', { where: ['cheeks', 'near-eyes', 'nose'] })).toEqual(professional('near-eyes'))
    expect(decide(['itching'], 'mild', { where: ['everywhere', 'cheeks'] })).toEqual(advice('advice-itching'))
  })
})

describe('outcomeFor, precedence between rules', () => {
  it('names pus or a hot patch before swelling when both are logged', () => {
    expect(decide(['swelling', 'pus-or-hot-patch'], 'mild')).toEqual(professional('pus-or-hot-patch'))
    expect(decide(['pus-or-hot-patch', 'swelling'], 'hard-to-ignore')).toEqual(professional('pus-or-hot-patch'))
  })

  it('names swelling before near-eyes when both apply', () => {
    expect(decide(['swelling'], 'noticeable', { where: ['near-eyes'] })).toEqual(professional('swelling'))
  })

  it('names pus or a hot patch before swelling and near-eyes when all three apply', () => {
    expect(decide(['swelling', 'pus-or-hot-patch'], 'noticeable', { where: ['near-eyes'] })).toEqual(professional('pus-or-hot-patch'))
  })

  it('lets a red flag win over a harm signal that would pause, at any level', () => {
    for (const howBad of HOW_BAD) {
      expect(decide(['stinging-or-burning', 'swelling'], howBad)).toEqual(professional('swelling'))
      expect(decide(['new-redness', 'pus-or-hot-patch'], howBad)).toEqual(professional('pus-or-hot-patch'))
    }
  })

  it('lets a red flag win over a hard-to-ignore pause while a step-down is running', () => {
    expect(decide(['new-redness', 'swelling'], 'hard-to-ignore', { stepDown: true })).toEqual(professional('swelling'))
  })

  it('lets a pause win over advice when a harm signal is logged with a milder symptom', () => {
    expect(decide(['stinging-or-burning', 'tightness-or-dryness'], 'mild')).toEqual(PAUSE)
    expect(decide(['itching', 'new-redness', 'new-breakouts'], 'noticeable')).toEqual(PAUSE)
  })

  it('pauses on any symptom at hard-to-ignore, even a combination that is only advice at a lower level', () => {
    expect(decide(['tightness-or-dryness', 'itching', 'new-breakouts'], 'noticeable')).toEqual(advice('advice-tightness', 'advice-itching', 'advice-breakouts'))
    expect(decide(['tightness-or-dryness', 'itching', 'new-breakouts'], 'hard-to-ignore')).toEqual(PAUSE)
  })

  it('does not mark a pause as during a step-down when none is running', () => {
    expect(decide(['new-redness'], 'hard-to-ignore')).toEqual({ kind: 'pause', duringStepDown: false })
  })
})

describe('outcomeFor, during a running step-down', () => {
  it('explains a mild or noticeable harm signal as the expected flare, even with a milder symptom beside it', () => {
    expect(decide(['stinging-or-burning', 'itching'], 'mild', { stepDown: true })).toEqual(FLARE)
    expect(decide(['new-redness', 'tightness-or-dryness', 'new-breakouts'], 'noticeable', { stepDown: true })).toEqual(FLARE)
    expect(decide(['stinging-or-burning', 'new-redness'], 'noticeable', { stepDown: true })).toEqual(FLARE)
  })

  it('pauses (marked) on any hard-to-ignore symptom, a harm signal or not', () => {
    expect(decide(['stinging-or-burning'], 'hard-to-ignore', { stepDown: true })).toEqual(PAUSE_DURING_STEP_DOWN)
    expect(decide(['itching', 'new-redness'], 'hard-to-ignore', { stepDown: true })).toEqual(PAUSE_DURING_STEP_DOWN)
  })

  it('leaves advice, a red flag and a good day exactly as they are without a step-down', () => {
    for (const noticing of [['itching'], ['tightness-or-dryness', 'new-breakouts'], ['swelling'], ['pus-or-hot-patch'], ['nothing-unusual']] as Noticing[][]) {
      const howBad = noticing[0] === 'nothing-unusual' ? null : 'mild'
      expect(decide(noticing, howBad, { stepDown: true })).toEqual(decide(noticing, howBad, { stepDown: false }))
    }
  })
})

describe('outcomeFor, advice codes', () => {
  it('lists every advice code that applies, in the order tightness, itching, breakouts, whatever order they were logged in', () => {
    const orders: Noticing[][] = [
      ['tightness-or-dryness', 'itching', 'new-breakouts'],
      ['tightness-or-dryness', 'new-breakouts', 'itching'],
      ['itching', 'tightness-or-dryness', 'new-breakouts'],
      ['itching', 'new-breakouts', 'tightness-or-dryness'],
      ['new-breakouts', 'tightness-or-dryness', 'itching'],
      ['new-breakouts', 'itching', 'tightness-or-dryness'],
    ]
    for (const order of orders) expect(decide(order, 'mild')).toEqual(advice('advice-tightness', 'advice-itching', 'advice-breakouts'))
  })

  it('lists just the codes of the symptoms logged', () => {
    expect(decide(['new-breakouts', 'tightness-or-dryness'], 'noticeable')).toEqual(advice('advice-tightness', 'advice-breakouts'))
    expect(decide(['itching', 'new-breakouts'], 'mild')).toEqual(advice('advice-itching', 'advice-breakouts'))
  })
})

describe('outcomeFor, every combination of symptoms', () => {
  // A sweep over all 127 non-empty sets of symptoms, three levels, with and without a step-down, and three places. It checks what must hold for every one of them
  // (the rules as properties), where the tables above check the exact answer for the cases that matter.
  const subsets = (items: Noticing[]): Noticing[][] => {
    const all: Noticing[][] = []
    for (let mask = 1; mask < 1 << items.length; mask++) all.push(items.filter((_, index) => mask & (1 << index)))
    return all
  }

  it('holds the rules for each of them', () => {
    const failures: string[] = []
    let checked = 0
    for (const noticing of subsets(SYMPTOMS)) {
      for (const howBad of HOW_BAD) {
        for (const stepDown of [false, true]) {
          for (const where of [[], ['cheeks'], ['near-eyes']] as Where[][]) {
            checked++
            const outcome = decide(noticing, howBad, { where, stepDown })
            const label = `${noticing.join('+')} / ${howBad} / ${where.join('+') || 'nowhere'} / ${stepDown ? 'step-down' : 'no step-down'} -> ${JSON.stringify(outcome)}`
            const has = (symptom: Noticing) => noticing.includes(symptom)
            const redFlag = has('swelling') || has('pus-or-hot-patch') || where.includes('near-eyes')
            const harm = has('stinging-or-burning') || has('new-redness')
            const problems: string[] = []
            if ((outcome.kind === 'professional') !== redFlag) problems.push('professional exactly when a red flag is present')
            if (outcome.kind === 'logged') problems.push('logged is only for nothing-unusual')
            if (!redFlag && howBad === 'hard-to-ignore' && outcome.kind !== 'pause') problems.push('hard-to-ignore pauses')
            if (!redFlag && harm && howBad !== 'hard-to-ignore' && outcome.kind !== (stepDown ? 'expected-flare' : 'pause')) problems.push('a harm signal pauses, or is the expected flare during a step-down')
            if (!redFlag && !harm && howBad !== 'hard-to-ignore' && outcome.kind !== 'advice') problems.push('milder symptoms are advice')
            if (outcome.kind === 'pause' && outcome.duringStepDown !== (stepDown && howBad === 'hard-to-ignore')) problems.push('duringStepDown only for hard-to-ignore in a step-down')
            if (outcome.kind === 'expected-flare' && !stepDown) problems.push('expected-flare needs a running step-down')
            if (outcome.kind === 'advice') {
              const order = ['advice-tightness', 'advice-itching', 'advice-breakouts']
              const wanted = [has('tightness-or-dryness') && 'advice-tightness', has('itching') && 'advice-itching', has('new-breakouts') && 'advice-breakouts'].filter(Boolean)
              if (JSON.stringify(outcome.codes) !== JSON.stringify(wanted) || outcome.codes.some((code, index) => index > 0 && order.indexOf(code) <= order.indexOf(outcome.codes[index - 1]!)))
                problems.push('advice lists each code that applies once, in order')
            }
            if (problems.length > 0) failures.push(`${label}: ${problems.join('; ')}`)
          }
        }
      }
    }

    expect(checked).toBe(127 * 3 * 2 * 3)
    expect(failures).toEqual([])
  })
})

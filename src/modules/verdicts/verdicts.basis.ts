import { rulesMatching } from '../catalog/catalog.rules'
import type { VerdictClaimWord } from '../catalog/catalog.workbook.service'
import type { FloorFact, FloorRule } from './verdicts.floor'
import { claimWordStatement, FIT_LINE, NO_LABEL_PURPOSE_LINE, NO_LABEL_UNKNOWN_LINE, TOLD_US_PRESCRIPTION_LINE, TOLD_US_REACTION_LINE } from './verdicts.copy'

// Where a product's verdict comes from (spec #259, PR A3): the list saved with the product as `basis`, built when the verdict is built and never looked up again,
// so a later edit or retirement of a rule leaves a saved verdict saying what it said. A PURE mapping of the floor's facts, or of the fit judge's say, over the
// approved rules the floor was given. Every basis has a fixed `line` the app shows as it is: a rule's own statement, or copy in verdicts.copy.ts.

export type Basis =
  | { kind: 'rule'; source: 'ingredient-rule' | 'claim-word'; statement: string; sourceUrl: string | null; reviewerRole: string | null; line: string }
  | { kind: 'fit'; line: string }
  | { kind: 'told-us'; about: 'reaction' | 'prescription'; line: string }
  | { kind: 'no-label'; about: 'purpose' | 'unknown-contents'; line: string }

/** The approved rules the floor read and the approved claim words. `reviewerRole` is null for a rule stored before contract 2.4.0; a `VerdictReference` is one of these. */
export type BasisReference = {
  rules: readonly (FloorRule & { reviewerRole?: string | null })[]
  claimWords: readonly VerdictClaimWord[]
}

/** The only basis of a product the fit judge decided, or one a clash made stricter after it. */
export const fitBasis = (): Basis => ({ kind: 'fit', line: FIT_LINE })

const ruleBasis = (rule: BasisReference['rules'][number]): Basis => ({
  kind: 'rule',
  source: 'ingredient-rule',
  statement: rule.rule,
  sourceUrl: rule.source,
  reviewerRole: rule.reviewerRole ?? null,
  line: rule.rule,
})

const claimBasis = (phrase: string, claimWords: BasisReference['claimWords']): Basis => {
  const word = claimWords.find((candidate) => candidate.phrase === phrase)
  if (!word) throw new Error(`No approved claim word ${JSON.stringify(phrase)}, which a product was flagged for`)
  const statement = claimWordStatement(phrase)
  return { kind: 'rule', source: 'claim-word', statement, sourceUrl: word.sourceUrl, reviewerRole: word.reviewerRole, line: statement }
}

/** The rule the floor's own fact rests on. Two rules can share a name (retinol is an irritant and a pregnancy caution), so the group or the kind picks the one that decided. */
const decidingRule = (fact: Extract<FloorFact, { kind: 'ingredient-group' | 'banned-substance' | 'pregnancy-caution' }>, rules: BasisReference['rules']): BasisReference['rules'][number] => {
  const candidates =
    fact.kind === 'ingredient-group'
      ? rules.filter((rule) => rule.group === fact.group && rule.name === fact.ruleName)
      : fact.kind === 'banned-substance'
        ? rules.filter((rule) => rule.kind === 'banned-substance' && rule.name === fact.ruleName)
        : rules.filter((rule) => rule.kind === 'pregnancy-caution')
  const found = rulesMatching(fact.ingredient, candidates)[0]
  if (!found) throw new Error(`No approved rule behind the ${fact.kind} fact for ${fact.ingredient}`)
  return found
}

/** The bases a fact gives, rules first within the fact. */
const basesOf = (fact: FloorFact, { rules, claimWords }: BasisReference): Basis[] => {
  switch (fact.kind) {
    case 'ingredient-group':
    case 'banned-substance':
    case 'pregnancy-caution':
      return [ruleBasis(decidingRule(fact, rules))]
    case 'claim-phrase':
      return [claimBasis(fact.phrase, claimWords)]
    case 'reaction-ingredient': {
      // The ingredient may have no rule at all; what the user told us is the basis then.
      const rule = rulesMatching(fact.ingredient, rules)[0]
      return [...(rule ? [ruleBasis(rule)] : []), { kind: 'told-us', about: 'reaction', line: TOLD_US_REACTION_LINE }]
    }
    case 'reaction-product':
      return [{ kind: 'told-us', about: 'reaction', line: TOLD_US_REACTION_LINE }]
    case 'prescription':
      return [{ kind: 'told-us', about: 'prescription', line: TOLD_US_PRESCRIPTION_LINE }]
    case 'no-label-purpose':
      return [{ kind: 'no-label', about: 'purpose', line: NO_LABEL_PURPOSE_LINE }]
    case 'unknown-contents':
      return [{ kind: 'no-label', about: 'unknown-contents', line: NO_LABEL_UNKNOWN_LINE }]
  }
}

/** Every basis of the facts of a product the floor decided, once each: the rules first, in the order of the facts, then the rest in that order. */
export const floorBasisOf = (facts: readonly FloorFact[], reference: BasisReference): Basis[] => {
  const seen = new Set<string>()
  const all = facts.flatMap((fact) => basesOf(fact, reference)).filter((basis) => {
    const key = JSON.stringify(basis)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [...all.filter(({ kind }) => kind === 'rule'), ...all.filter(({ kind }) => kind !== 'rule')]
}

import { sha256Hex } from '../../lib/crypto'
import { stableJson } from '../../lib/stable-json'
import type { Category, TaperKind } from '../catalog/catalog.vocabulary'
import type { Band, ShownConcern, SkinTypeLabel } from '../face-scans/face-scans.tables'
import type { Goal } from '../goals/goals.vocabulary'
import type { NoLabelPurpose } from '../scans/scans.vocabulary'
import type { ParseState, SafetyMentionRow, SafetyView } from '../safety/safety.types'
import type { FloorRule } from './verdicts.floor'

// What a saved verdict was built from, as one hash (spec #171): a change to any input makes the verdict stale and the next read rebuilds it; no change leaves it
// alone, which is what keeps the judge from being billed twice for one shelf. Every field is picked by name, never spread, so an input the verdict does not
// read (the global catalog version, so a Products-only upload re-bills nothing) cannot leak in, and anything that only says when or where a row was stored
// (ids, times, positions) is left out so a re-save of identical answers hashes the same.

type ShelfBase = { id: string; category: Category; brand: string | null; name: string; variant: string | null }

export type FingerprintShelfEntry = ShelfBase & ({ kind: 'product'; formulationId: string } | { kind: 'no-label'; noLabelPurpose: NoLabelPurpose })

export type FingerprintInput = {
  rulesVersion: string
  /** The live rules as the floor and the judge read them. */
  rules: readonly (FloorRule & { helps: ShownConcern[] })[]
  claimPhrases: readonly string[]
  tapers: Readonly<Partial<Record<TaperKind, string>>>
  goal: Goal | null
  /** The profile's active entries of any category: only skin is hashed. */
  shelf: readonly FingerprintShelfEntry[]
  safety: { view: SafetyView | null; parseState: ParseState | null; mentions: readonly SafetyMentionRow[] }
  /** The latest face scan's levels, or null when there is none. */
  scan: { skinType: SkinTypeLabel | null; concerns: readonly { concern: ShownConcern; band: Band }[] } | null
  model: string
  promptHash: string
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const sorted = <T extends string>(items: readonly T[]): T[] => [...items].sort(byText)

const ruleOf = ({ name, aliases, kind, rule, source, group, clashesWith, helps }: FingerprintInput['rules'][number]) => ({
  name,
  aliases: sorted(aliases),
  kind,
  rule,
  source,
  group,
  clashesWith: sorted(clashesWith),
  helps: sorted(helps),
})

const shelfEntryOf = (entry: FingerprintShelfEntry) => ({
  id: entry.id,
  brand: entry.brand,
  name: entry.name,
  variant: entry.variant,
  ...(entry.kind === 'product' ? { kind: entry.kind, formulationId: entry.formulationId } : { kind: entry.kind, noLabelPurpose: entry.noLabelPurpose }),
})

const mentionOf = ({ source, kind, brand, name, variant, category, productId, resolution }: SafetyMentionRow) => ({ source, kind, brand, name, variant, category, productId, resolution })

const safetyOf = ({ view, parseState, mentions }: FingerprintInput['safety']) => ({
  view: view && {
    choices: sorted(view.choices),
    reactionText: view.reactionText,
    prescriptionText: view.prescriptionText,
    excludesPregnancyCaution: view.excludesPregnancyCaution,
  },
  parseState,
  mentions: mentions.map(mentionOf).sort((a, b) => byText(stableJson(a), stableJson(b))),
})

export const verdictFingerprint = (input: FingerprintInput): Promise<string> =>
  sha256Hex(
    stableJson({
      rulesVersion: input.rulesVersion,
      // A total order over the whole rule, not the name: two rules may share a name (one per kind or statement), and the order they arrive in must not change the hash.
      rules: input.rules.map(ruleOf).sort((a, b) => byText(stableJson(a), stableJson(b))),
      claimPhrases: sorted(input.claimPhrases),
      tapers: input.tapers,
      goal: input.goal,
      shelf: input.shelf
        .filter((entry) => entry.category === 'skin')
        .map(shelfEntryOf)
        .sort((a, b) => byText(a.id, b.id)),
      safety: safetyOf(input.safety),
      scan: input.scan && {
        skinType: input.scan.skinType,
        concerns: input.scan.concerns.map(({ concern, band }) => ({ concern, band })).sort((a, b) => byText(a.concern, b.concern)),
      },
      model: input.model,
      promptHash: input.promptHash,
    }),
  )

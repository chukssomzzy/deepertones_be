import type { z } from '@hono/zod-openapi'
import type { TaperRow } from '../catalog/catalog.workbook.schema'
import type { Escalation } from '../catalog/catalog.workbook.service'
import { toNoLabelResponse, toProductResponse } from '../scans/scans.presenter'
import { DROP_SUGGESTION, ESCALATE_SUGGESTION, GROUP_COPY, GROUP_ORDER, KEEP_SUGGESTION, PHOTOGRAPH_SUGGESTION, reduceSuggestion, stopSuggestion } from './verdicts.screen-copy'
import type { VerdictGroup } from './verdicts.merge'
import type { SavedVerdictProduct, ShownVerdictProduct } from './verdicts.types'
import type { ShelfVerdictResponse, VerdictGroupResponse, VerdictProductResponse, VerdictTaperResponse } from './verdicts.schemas'

/** What a guest is given of a ready verdict (owner decision, spec #171): how many products fall in each group, never which, so it cannot be read as the verdict. */
export type VerdictPreview = { status: 'ready'; locked: true; fit: 'ready' | 'not-ready'; total: number; counts: Record<VerdictGroup, number>; escalates: number }

/**
 * What GET /me/verdict answers: the build is on its way, or the saved verdict, in full with the step-down templates its stopped products use (retired ones
 * included) and the professional to see (null until the workbook has the row; read when the verdict is read, never saved) for a verified user, or as the
 * locked preview for a guest.
 */
export type VerdictView =
  | { status: 'pending' }
  | { status: 'ready'; locked: false; fit: 'ready' | 'not-ready'; products: ShownVerdictProduct[]; tapers: TaperRow[]; professional: Escalation | null }
  | VerdictPreview

// Every group is named so that a group added to the verdict is a compile error here, and a client always reads all of them.
const NO_PRODUCTS: Record<VerdictGroup, number> = {
  helping: 0,
  redundant: 0,
  blocking: 0,
  conflicting: 0,
  'likely-the-problem': 0,
  'cant-tell': 0,
  prescribed: 0,
  undecided: 0,
}

/** The one place a saved verdict becomes a guest's preview: `current`, the stream's snapshot and every frame published for a guest use it. Reads only what was saved, so it needs no shelf lookup. */
export const previewOf = (fit: 'ready' | 'not-ready', products: readonly SavedVerdictProduct[]): VerdictPreview => {
  const counts = { ...NO_PRODUCTS }
  for (const { group } of products) counts[group]++
  return { status: 'ready', locked: true, fit, total: products.length, counts, escalates: products.filter(({ escalate }) => escalate).length }
}

type PublicProduct = z.infer<typeof VerdictProductResponse>

// Fixed copy beside each group's count, in the screen's order and always all of them: the app hides the zeros.
const groupsOf = (counts: Record<VerdictGroup, number>): z.infer<typeof VerdictGroupResponse>[] => GROUP_ORDER.map((group) => ({ group, ...GROUP_COPY[group], count: counts[group] }))

// What to do with a product, from its verdict alone (the stop line reads the kind of the step-down it names), never from a model.
const suggestionsFor = ({ group, verdict, escalate }: ShownVerdictProduct, tapers: readonly TaperRow[]): string[] => {
  const lines =
    verdict.kind === 'keep'
      ? [KEEP_SUGGESTION]
      : verdict.kind === 'reduce'
        ? [reduceSuggestion(verdict.maxFrequency)]
        : verdict.kind === 'stop'
          ? stopSuggestion(tapers.find(({ code }) => code === verdict.taperTemplateId)?.kind)
          : [DROP_SUGGESTION, ...(escalate ? [ESCALATE_SUGGESTION] : [])]
  return group === 'cant-tell' ? [...lines, PHOTOGRAPH_SUGGESTION] : lines
}

// Written out field by field: `facts`, `step` and `sourceUrls` are how the rules reached a verdict, not what the user is shown (`basis` is the part of them written
// for the user, and is named below), and a field added to the saved product later must not reach a client unless it is named here.
const toProduct = (shown: ShownVerdictProduct, tapers: readonly TaperRow[]): PublicProduct => {
  const { entryId, group, verdict, reason, escalate, basis, sameJobAs, nudge } = shown
  return {
    entryId,
    // The shelf entry's own, through the presenters GET /me/shelf uses, so the two bodies cannot drift.
    ...(shown.kind === 'product'
      ? { kind: shown.kind, product: toProductResponse(shown.product) }
      : shown.kind === 'no-label'
        ? { kind: shown.kind, noLabel: toNoLabelResponse(shown.noLabel) }
        : {}),
    group,
    verdict: verdict.kind === 'stop' ? { kind: 'stop', taperCode: verdict.taperTemplateId } : verdict,
    reason,
    escalate,
    basis,
    ...(sameJobAs === undefined ? {} : { sameJobAs }),
    ...(nudge === undefined ? {} : { nudge }),
    suggest: suggestionsFor(shown, tapers),
  }
}

// The workbook reader has already turned the schedule cell into steps, so there is nothing to parse here. A template's status and audit columns are left out.
const toTaper = ({ code, kind, schedule, whatToExpect, seeAProfessionalIf }: TaperRow): z.infer<typeof VerdictTaperResponse> => ({
  code,
  kind,
  // A step's frequency is typed as text, but the workbook reader refuses a schedule whose frequency is not a routine frequency or stop.
  schedule: schedule.map(({ fromWeek, toWeek, frequency }) => ({ fromWeek, toWeek, frequency })) as z.infer<typeof VerdictTaperResponse>['schedule'],
  whatToExpect,
  seeAProfessionalIf,
})

// The service sends this same body on the event stream, and the routes answer it: one mapping, in a file both may import.
export const toShelfVerdictResponse = (view: VerdictView): z.infer<typeof ShelfVerdictResponse> => {
  if (view.status === 'pending') return { status: 'pending' }
  if (view.locked) return { ...view, groups: groupsOf(view.counts) }
  const counts = { ...NO_PRODUCTS }
  for (const { group } of view.products) counts[group]++
  return { status: 'ready', locked: false, fit: view.fit, groups: groupsOf(counts), products: view.products.map((shown) => toProduct(shown, view.tapers)), tapers: view.tapers.map(toTaper), professional: view.professional && { whoToSee: view.professional.whoToSee, howSoon: view.professional.howSoon, whatToTellThem: view.professional.whatToTellThem } }
}

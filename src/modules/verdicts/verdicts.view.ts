import type { z } from '@hono/zod-openapi'
import type { TaperRow } from '../catalog/catalog.workbook.schema'
import type { SavedVerdictProduct } from './verdicts.types'
import type { ShelfVerdictResponse, VerdictProductResponse, VerdictTaperResponse } from './verdicts.schemas'

/** What GET /me/verdict answers: the build is on its way, or the saved verdict with the step-down templates its stopped products use (retired ones included). */
export type VerdictView = { status: 'pending' } | { status: 'ready'; fit: 'ready' | 'not-ready'; products: SavedVerdictProduct[]; tapers: TaperRow[] }

type PublicProduct = z.infer<typeof VerdictProductResponse>

// Written out field by field: `facts`, `step` and `sourceUrls` are how the rules reached a verdict, not what the user is shown, and a field added to the saved
// product later must not reach a client unless it is named here.
const toProduct = ({ entryId, group, verdict, reason, escalate, sameJobAs, nudge }: SavedVerdictProduct): PublicProduct => ({
  entryId,
  group,
  verdict: verdict.kind === 'stop' ? { kind: 'stop', taperCode: verdict.taperTemplateId } : verdict,
  reason,
  escalate,
  ...(sameJobAs === undefined ? {} : { sameJobAs }),
  ...(nudge === undefined ? {} : { nudge }),
})

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
export const toShelfVerdictResponse = (view: VerdictView): z.infer<typeof ShelfVerdictResponse> =>
  view.status === 'pending' ? { status: 'pending' } : { status: 'ready', fit: view.fit, products: view.products.map(toProduct), tapers: view.tapers.map(toTaper) }

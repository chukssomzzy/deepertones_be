import { z } from '@hono/zod-openapi'
import { ROUTINE_STEPS } from '../catalog/catalog.vocabulary'
import { ADVICE_CODES, OUTCOME_KINDS, PROFESSIONAL_REASONS } from './skin-care.outcomes'
import { HOW_BAD, NOTICING, WHERE } from './skin-care.vocabulary'

const NoticingEnum = z.enum(NOTICING).openapi({
  description:
    'What the person is noticing: `stinging-or-burning`, `new-redness`, `tightness-or-dryness`, `new-breakouts`, `itching`, `swelling`, `pus-or-hot-patch` or `nothing-unusual`. `nothing-unusual` only ever stands alone.',
})
const WhereEnum = z.enum(WHERE).openapi({ description: 'Where on the face: `cheeks`, `nose`, `forehead`, `neck`, `chin-and-jaw`, `near-eyes` or `everywhere`.' })
const HowBadEnum = z.enum(HOW_BAD).openapi({ description: 'How bad it is, one choice: `mild`, `noticeable` or `hard-to-ignore`.' })

export const LogSkinBody = z
  .object({
    noticing: z.array(NoticingEnum).openapi({ description: 'At least one. A symptom named twice counts once.' }),
    where: z.array(WhereEnum).optional().openapi({ description: 'Choose any. Not with `nothing-unusual`.' }),
    howBad: HowBadEnum.nullable().optional().openapi({ description: 'Required for anything but `nothing-unusual`.' }),
    note: z
      .string()
      .nullable()
      .optional()
      .openapi({ description: 'Optional, at most 500 characters (counted as characters, not bytes). It is stored and shown back only on the professional screen; no rule reads it.' }),
  })
  .openapi('LogSkinBody')

const SkinLogView = z.object({
  id: z.string(),
  day: z.string().openapi({ description: 'The local calendar day of the log, `YYYY-MM-DD`.', example: '2030-06-15' }),
  noticing: z.array(NoticingEnum),
  where: z.array(WhereEnum),
  howBad: HowBadEnum.nullable(),
  outcome: z.enum(OUTCOME_KINDS).openapi({ description: 'What the log came to, as it was decided (a `pause` the rules came to may end as `professional` or `nothing-to-pause`).' }),
})

const Outcome = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('pause'), duringStepDown: z.boolean() }),
    z.object({ kind: z.literal('professional'), reason: z.enum(PROFESSIONAL_REASONS) }),
    z.object({ kind: z.literal('nothing-to-pause') }),
    z.object({ kind: z.literal('expected-flare') }),
    z.object({ kind: z.literal('advice'), codes: z.array(z.enum(ADVICE_CODES)) }),
    z.object({ kind: z.literal('logged') }),
  ])
  .openapi({ description: 'The final action. Branch on `kind`.' })

const ReviewedText = z.object({ title: z.string(), body: z.string(), whatToDoNow: z.string().nullable() })

const ProfessionalText = z.object({
  whoToSee: z.string(),
  howSoon: z.string(),
  whatToTellThem: z.string(),
  facts: z.object({ noticing: z.array(NoticingEnum), where: z.array(WhereEnum), howBad: HowBadEnum.nullable(), note: z.string().nullable() }).openapi({ description: 'What the person logged, repeated back on the professional screen.' }),
})

export const LogSkinResponse = z
  .object({
    log: SkinLogView,
    outcome: Outcome,
    response: z
      .union([z.array(ReviewedText), ReviewedText, ProfessionalText, z.null()])
      .openapi({ description: 'The reviewed text, with `{step}` already filled: a list for `advice` (one for each thing noticed), one text for `pause`, `nothing-to-pause` and `expected-flare`, the professional text for `professional`, and null for `logged`.' }),
    paused: z
      .object({
        id: z.string(),
        step: z.enum(ROUTINE_STEPS),
        title: z.string().openapi({ description: "The routine's own title for the paused step." }),
        checkDay: z.string().openapi({ description: 'The local day the person is asked how it feels, `YYYY-MM-DD`: three days on.', example: '2030-06-18' }),
      })
      .nullable()
      .openapi({ description: 'The pause this log made; null for every outcome but `pause`.' }),
  })
  .openapi('LogSkinResult')

export const SkinLogsResponse = z.object({ logs: z.array(SkinLogView).openapi({ description: 'The last 20, newest first. Never the note.' }) }).openapi('SkinLogs')

export const PauseParams = z.object({
  id: z.string().min(1).openapi({ param: { name: 'id', in: 'path' }, description: "The pause's id (`paused.id` of a log)." }),
})

export const UndoPauseResponse = z.object({ id: z.string(), state: z.literal('undone') }).openapi('UndoPauseResult')

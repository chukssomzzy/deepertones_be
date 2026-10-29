import { z } from '@hono/zod-openapi'
import { FREQUENCIES, TAPER_KINDS } from '../catalog/catalog.vocabulary'
import { NoLabelResponse, ProductSummary } from '../scans/scans.schemas'

const GROUPS = ['prescribed', 'likely-the-problem', 'conflicting', 'cant-tell', 'helping', 'redundant', 'blocking', 'undecided'] as const

const VerdictResponse = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('keep') }),
    z.object({ kind: z.literal('reduce'), maxFrequency: z.enum(FREQUENCIES).openapi({ description: 'Keep it, but no more often than this.' }) }),
    z.object({ kind: z.literal('stop'), taperCode: z.string().openapi({ description: 'The `code` of the step-down in `tapers` to follow.' }) }),
    z.object({ kind: z.literal('drop') }),
  ])
  .openapi('ShelfVerdictAction', { description: 'What to do with the product: `keep` it, `reduce` it, `stop` it by a step-down, or `drop` it at once.' })

export const VerdictProductResponse = z
  .object({
    entryId: z.string().openapi({ description: 'The shelf entry this is about: its `id` from `GET /api/v1/me/shelf`.' }),
    kind: z
      .enum(['product', 'no-label'])
      .optional()
      .openapi({ description: 'The shelf entry\'s own kind: `product` carries `product`; `no-label` carries `noLabel`. Absent only when the shelf entry can no longer be shown (it was taken off the shelf since the verdict was built): the product is still here, with its verdict, and carries neither.' }),
    product: ProductSummary.optional().openapi({ description: 'Only on a `product` entry: the same summary `GET /api/v1/me/shelf` shows for it.' }),
    noLabel: NoLabelResponse.optional().openapi({ description: 'Only on a `no-label` entry: the same view `GET /api/v1/me/shelf` shows for it.' }),
    group: z.enum(GROUPS).openapi({ description: 'The heading the product is shown under.' }),
    verdict: VerdictResponse,
    reason: z.string().openapi({ description: 'Why, in words for the user.' }),
    escalate: z.boolean().openapi({ description: 'True when the user should see a professional about this product.' }),
    sameJobAs: z.string().optional().openapi({ description: 'Only on a `redundant` product: the entry id of the product that stays and does its job.' }),
    nudge: z.literal('photograph-back-label').optional().openapi({ description: 'Only on a `cant-tell` product: what to do to get it read.' }),
    suggest: z.array(z.string()).min(1).openapi({ description: 'One or more (usually one to three) fixed lines on what to do with the product, worked out from `verdict` alone (and `escalate`, and the `cant-tell` group). Copy awaiting the owner\'s sign-off.' }),
  })
  .openapi('ShelfVerdictProduct')

export const VerdictTaperResponse = z
  .object({
    code: z.string().openapi({ description: 'The step-down\'s code, as a `stop` verdict names it.' }),
    kind: z.enum(TAPER_KINDS),
    schedule: z
      .array(
        z.object({
          fromWeek: z.number().int().openapi({ description: 'The first week of the step, counting from 1.' }),
          toWeek: z.number().int().openapi({ description: 'The last week of the step; the same as `fromWeek` for a single week.' }),
          frequency: z.enum([...FREQUENCIES, 'stop']),
        }),
      )
      .openapi({ description: 'The steps in order, ending with `stop`.' }),
    whatToExpect: z.string(),
    seeAProfessionalIf: z.string(),
  })
  .openapi('ShelfVerdictTaper')

const GroupCounts = z
  .object({
    helping: z.number().int(),
    redundant: z.number().int(),
    blocking: z.number().int(),
    conflicting: z.number().int(),
    'likely-the-problem': z.number().int(),
    'cant-tell': z.number().int(),
    prescribed: z.number().int(),
    undecided: z.number().int(),
  })
  .openapi({ description: 'How many products are under each heading; 0 where there are none. Every heading is always present.' })

export const VerdictGroupResponse = z
  .object({
    group: z.enum(GROUPS),
    title: z.string().openapi({ description: 'The heading, e.g. "Helping". `undecided` is shown as "Still checking".' }),
    subtitle: z.string(),
    intro: z.string().openapi({ description: 'One or two plain sentences about the products under the heading.' }),
    count: z.number().int().nonnegative().openapi({ description: 'How many products are under it; 0 where there are none.' }),
  })
  .openapi('ShelfVerdictGroup')

const GROUP_LIST = z.array(VerdictGroupResponse).openapi({
  description: 'All eight headings in the order the screen shows them, each with fixed words and its product count (0 where empty; the app hides the zeros). Copy awaiting the owner\'s sign-off.',
})

const FIT = z.enum(['ready', 'not-ready']).openapi({ description: '`not-ready` when the goal-fit check has not answered yet: the products it would decide are shown as kept for now, and it is tried again.' })

// A plain `z.union`: `locked` tells the two ready shapes apart, and `status` alone could not.
export const ShelfVerdictResponse = z
  .union([
    z.object({ status: z.literal('pending') }),
    z.object({
      status: z.literal('ready'),
      locked: z.literal(true).openapi({ description: 'A guest is given this preview and never the products: sign up to see them.' }),
      fit: FIT,
      groups: GROUP_LIST,
      total: z.number().int().openapi({ description: 'How many skin-care products the verdict holds.' }),
      counts: GroupCounts,
      escalates: z.number().int().openapi({ description: 'How many products carry `escalate`: how many to see a professional about, without saying which.' }),
    }),
    z.object({
      status: z.literal('ready'),
      locked: z.literal(false).openapi({ description: 'A verified user is given the full verdict.' }),
      fit: FIT,
      groups: GROUP_LIST,
      products: z.array(VerdictProductResponse).openapi({ description: 'One per skin-care product on the shelf, in shelf order.' }),
      tapers: z.array(VerdictTaperResponse).openapi({ description: 'The step-downs the `stop` verdicts use, each once.' }),
    }),
  ])
  .openapi('ShelfVerdict')

import type { Response } from '../catalog/catalog.workbook.service'

const PLACEHOLDER = '{step}'
const NO_STEP = 'your routine'

/**
 * Fills every `{step}` of a reviewed text: with the plain noun of the step the answer is about (Cleanser, Treatment, Moisturiser or Sunscreen, never a product title), or
 * "your routine" when the answer is about no step (`null`). The workbook allows no other placeholder, so this is the only fill there is.
 */
export const fillStep = (text: string, noun: string | null): string => text.split(PLACEHOLDER).join(noun ?? NO_STEP)

/** A reviewed response with its `{step}` filled in the title, the body and what to do now. */
export const fillResponse = (response: Response, noun: string | null): Response => ({
  title: fillStep(response.title, noun),
  body: fillStep(response.body, noun),
  whatToDoNow: response.whatToDoNow === null ? null : fillStep(response.whatToDoNow, noun),
})

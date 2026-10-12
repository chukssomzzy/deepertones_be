import type { SafeHtml } from '../html'

export type TemplateOutput = { subject: string; preheader?: string; body: SafeHtml }

export type EmailTemplate<Data> = {
  render: (data: Data) => TemplateOutput
  /** Example data for the preview script and the layout tests. */
  sample: Data
}

/** Pins the data type once so `render` and `sample` cannot drift apart. */
export const defineTemplate = <Data>(template: EmailTemplate<Data>): EmailTemplate<Data> => template

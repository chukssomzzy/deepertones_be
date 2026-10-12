import { convert } from 'html-to-text'
import { layout, PREHEADER_CLASS } from './components/layout'
import type { EmailContent } from './html'
import { otpCode } from './templates/otp-code'
import type { EmailTemplate, TemplateOutput } from './templates/template'

export const templates = {
  'otp-code': otpCode,
} satisfies Record<string, { render(data: never): TemplateOutput; sample: unknown }>

export type EmailTemplateName = keyof typeof templates
export type EmailData<N extends EmailTemplateName> = (typeof templates)[N]['sample']

// Layout tables are positioning only, so they flatten to plain blocks instead of ASCII grids.
const TEXT_OPTIONS = {
  wordwrap: false,
  selectors: [
    { selector: `.${PREHEADER_CLASS}`, format: 'skip' },
    { selector: 'img', format: 'skip' },
    { selector: 'table', format: 'block' },
    { selector: 'tr', format: 'block' },
    { selector: 'td', format: 'block' },
    { selector: 'a', options: { hideLinkHrefIfSameAsText: true, linkBrackets: ['[', ']'] } },
  ],
} satisfies Parameters<typeof convert>[1]

export const renderEmail = <N extends EmailTemplateName>(name: N, data: EmailData<N>): EmailContent => {
  const template = templates[name] as EmailTemplate<EmailData<N>>
  const { subject, preheader, body } = template.render(data)
  const page = layout({ subject, preheader, body }).value
  return { subject, html: page, text: convert(page, TEXT_OPTIONS) }
}

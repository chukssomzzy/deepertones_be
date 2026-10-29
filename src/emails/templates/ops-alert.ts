import { paragraph } from '../components/paragraph'
import { html } from '../html'
import { defineTemplate } from './template'

/** For us, not for users. The text is fixed per kind: it names the environment and the kind and carries no data. */
export const opsAlert = defineTemplate<{ environment: string; kind: string; what: string; todo: string }>({
  render: ({ environment, kind, what, todo }) => ({
    subject: `[${environment}] ${kind}: Deeper Tones needs a look`,
    preheader: `${kind} in ${environment}.`,
    body: html`${paragraph(`Environment: ${environment}. Alert: ${kind}.`)}${paragraph(what)}${paragraph(todo)}${paragraph('You get this at most once an hour or once a day for each alert, depending on the alert.', { muted: true })}`,
  }),
  sample: {
    environment: 'staging',
    kind: 'ai-account',
    what: 'Claude refused our account.',
    todo: 'Check the billing and the API key.',
  },
})

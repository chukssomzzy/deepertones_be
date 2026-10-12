import { codeBox } from '../components/code-box'
import { paragraph } from '../components/paragraph'
import { html } from '../html'
import { defineTemplate } from './template'

const minutes = (n: number) => `${n} ${n === 1 ? 'minute' : 'minutes'}`

export const otpCode = defineTemplate<{ code: string; ttlMinutes: number }>({
  render: ({ code, ttlMinutes }) => ({
    subject: `${code} is your Deeper Tones sign-in code`,
    preheader: `Your code expires in ${minutes(ttlMinutes)}.`,
    body: html`${paragraph('Use this code to sign in to Deeper Tones:')}${codeBox(code)}${paragraph(`It expires in ${minutes(ttlMinutes)}.`)}${paragraph("If you didn't ask for this code, you can ignore this email.", { muted: true })}`,
  }),
  sample: { code: '482913', ttlMinutes: 10 },
})

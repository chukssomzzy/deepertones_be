/** Markup that is already safe to put in an email; `html` inserts it as is. Only `html` and `rawHtml` make one. */
export class SafeHtml {
  readonly value: string
  // Unforgeable outside this module: the token is not exported, so only `html` and `rawHtml` can construct.
  constructor(value: string, token: typeof TOKEN) {
    if (token !== TOKEN) throw new Error('Use html`` or rawHtml() to make SafeHtml')
    this.value = value
  }
}
const TOKEN = Symbol('SafeHtml')

export type EmailContent = { subject: string; html: string; text: string }

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c]!)

type Interpolation = string | number | SafeHtml | boolean | null | undefined | readonly Interpolation[]

const render = (value: Interpolation): string => {
  // Booleans render nothing so `${cond && html`...`}` works; `true` is dropped too rather than printed.
  if (value === null || value === undefined || typeof value === 'boolean') return ''
  if (value instanceof SafeHtml) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  return escapeHtml(String(value))
}

/**
 * Tagged template that escapes every interpolated value unless it is SafeHtml. That protects text
 * nodes and QUOTED attribute values; attribute values must be quoted. URLs are not validated: never
 * interpolate a user-supplied URL into href/src without checking its scheme.
 * Conditions must be booleans: `${n && html`...`}` with n = 0 renders "0"; write `${n > 0 && ...}`.
 */
export const html = (strings: TemplateStringsArray, ...values: Interpolation[]): SafeHtml =>
  new SafeHtml(strings.reduce((out, chunk, i) => out + chunk + (i < values.length ? render(values[i]!) : ''), ''), TOKEN)

/** Marks trusted markup as safe. Never pass it user input. */
export const rawHtml = (markup: string): SafeHtml => new SafeHtml(markup, TOKEN)

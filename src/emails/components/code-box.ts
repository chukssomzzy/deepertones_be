import { BRAND } from '../brand'
import { html, type SafeHtml } from '../html'

export const codeBox = (code: string): SafeHtml =>
  html`<p style="margin:24px 0;font-family:${BRAND.fonts.mono};font-size:32px;line-height:40px;font-weight:700;letter-spacing:8px;color:${BRAND.colors.purple};">${code}</p>`

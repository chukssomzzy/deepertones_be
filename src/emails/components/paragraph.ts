import { BRAND } from '../brand'
import { html, type SafeHtml } from '../html'

export const paragraph = (content: string | SafeHtml, opts: { muted?: boolean } = {}): SafeHtml =>
  html`<p style="margin:0 0 16px 0;font-family:${BRAND.fonts.serif};font-size:16px;line-height:24px;color:${opts.muted ? BRAND.colors.muted : BRAND.colors.bodyText};">${content}</p>`

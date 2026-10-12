import { BRAND } from '../brand'
import { html, type SafeHtml } from '../html'

export const footer = (): SafeHtml => html`<tr><td bgcolor="${BRAND.colors.footerBg}" style="background-color:${BRAND.colors.footerBg};border-top:1px solid ${BRAND.colors.border};padding:20px 32px;font-family:${BRAND.fonts.serif};font-size:12px;line-height:18px;color:${BRAND.colors.muted};">
<p style="margin:0 0 8px 0;">${BRAND.tagline}</p>
<p style="margin:0 0 8px 0;">Questions? <a href="mailto:${BRAND.supportEmail}" style="color:${BRAND.colors.purple};">${BRAND.supportEmail}</a></p>
<p style="margin:0;">© ${new Date().getUTCFullYear()} ${BRAND.name}</p>
</td></tr>`

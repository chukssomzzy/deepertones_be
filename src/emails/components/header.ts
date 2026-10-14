import { BRAND } from '../brand'
import { html, type SafeHtml } from '../html'

// Must stay the first <img> in the document: the layout test and mail clients' previews look for it.
export const header = (): SafeHtml => html`<tr><td align="left" bgcolor="${BRAND.colors.header}" style="background-color:${BRAND.colors.header};padding:24px 32px;">
<img src="${BRAND.logoUrl}" alt="${BRAND.name}" width="${BRAND.logo.width}" height="${BRAND.logo.height}" style="display:block;border:0;max-width:100%;height:auto;color:${BRAND.colors.lightText};font-family:${BRAND.fonts.serif};font-size:22px;line-height:40px;">
</td></tr>`

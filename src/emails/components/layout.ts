import { BRAND } from '../brand'
import { html, type SafeHtml } from '../html'
import { footer } from './footer'
import { header } from './header'

/** Class on the hidden preheader so the plain-text conversion can drop it. */
export const PREHEADER_CLASS = 'preheader'

/** The one Deeper Tones layout. Table-based with inline styles, because email clients ignore the rest. */
export const layout = (input: { subject: string; preheader?: string; body: SafeHtml }): SafeHtml => {
  const { subject, preheader, body } = input
  return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${subject}</title>
</head>
<body bgcolor="${BRAND.colors.pageBg}" style="margin:0;padding:0;background-color:${BRAND.colors.pageBg};">
${preheader ? html`<div class="${PREHEADER_CLASS}" style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.colors.pageBg}" style="background-color:${BRAND.colors.pageBg};">
<tr><td align="center" bgcolor="${BRAND.colors.pageBg}" style="padding:24px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:560px;background-color:#ffffff;">
${header()}
<tr><td bgcolor="#ffffff" style="padding:32px;">${body}</td></tr>
${footer()}
</table>
</td></tr>
</table>
</body>
</html>`
}

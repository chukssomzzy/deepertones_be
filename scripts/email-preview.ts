// Renders every registered email's sample to .email-preview/ and opens the index: `npm run emails:preview`.
// Pass --no-open to only write the files.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { renderEmail, templates, type EmailTemplateName } from '../src/emails/registry'

const dir = '.email-preview'
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir)

const names = Object.keys(templates) as EmailTemplateName[]
for (const name of names) {
  const out = renderEmail(name, templates[name].sample as never)
  writeFileSync(`${dir}/${name}.html`, out.html)
  writeFileSync(`${dir}/${name}.txt`, `Subject: ${out.subject}\n\n${out.text}\n`)
}

const items = names.map((n) => `<li>${n}: <a href="${n}.html">html</a> | <a href="${n}.txt">text</a></li>`).join('\n')
writeFileSync(`${dir}/index.html`, `<!DOCTYPE html><meta charset="utf-8"><title>Email preview</title><h1>Email preview</h1><ul>\n${items}\n</ul>\n`)
console.log(`wrote ${names.length} template(s) to ${dir}/`)

if (!process.argv.includes('--no-open')) execFileSync('open', [`${dir}/index.html`])

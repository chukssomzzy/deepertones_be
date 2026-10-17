// Writes src/prompts/prompts.generated.ts from the Markdown files in src/prompts/: `npm run prompts`.
// Commit the result. CI regenerates it and fails if the committed file is stale, so a prompt
// edit can't merge without the module the Worker actually imports.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parsePromptFiles, renderPromptsModule } from './prompts/generate'

const PROMPTS_DIR = path.resolve(import.meta.dirname, '../src/prompts')
const OUTPUT = path.join(PROMPTS_DIR, 'prompts.generated.ts')

const files = readdirSync(PROMPTS_DIR)
  .filter((name) => name.endsWith('.md'))
  .map((name) => ({ name, content: readFileSync(path.join(PROMPTS_DIR, name), 'utf8') }))

const result = parsePromptFiles(files)
if (!result.ok) {
  for (const error of result.errors) console.error(error)
  process.exit(1)
}

writeFileSync(OUTPUT, renderPromptsModule(result.prompts))
console.log('wrote src/prompts/prompts.generated.ts')

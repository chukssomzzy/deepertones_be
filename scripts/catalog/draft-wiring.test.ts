import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AI_JOBS } from '../../src/providers/anthropic/ai-spend.provider'
import { DEFAULT_MODELS } from '../eval/models'
import { parsePromptFiles, renderPromptsModule } from '../prompts/generate'

// What `catalog:draft` needs to exist besides its code: the AI job, the prompt behind it, the model it runs on, and the npm script.
const PROMPTS_DIR = path.resolve(import.meta.dirname, '../../src/prompts')
const PROMPT_FILE = 'catalog-drafter.draft-catalog-row.md'

const promptFiles = () => readdirSync(PROMPTS_DIR).filter((name) => name.endsWith('.md')).map((name) => ({ name, content: readFileSync(path.join(PROMPTS_DIR, name), 'utf8') }))

describe('the draft-catalog-row AI job', () => {
  it('is one of the AI jobs, so its calls are costed and capped like every other', () => {
    expect(AI_JOBS).toContain('draft-catalog-row')
  })

  it('runs on Haiku by default in the eval, since drafting is an internal job whose output a person reviews (the owner rule: Sonnet is for text users read)', () => {
    expect((DEFAULT_MODELS as Record<string, string>)['draft-catalog-row']).toBe('claude-haiku-5-5')
  })
})

describe(`src/prompts/${PROMPT_FILE}`, () => {
  it('exists, and is a valid prompt file for the draft-catalog-row job used by the drafter adapter', () => {
    const file = promptFiles().find((f) => f.name === PROMPT_FILE)
    expect(file, `${PROMPT_FILE} is missing from src/prompts`).toBeDefined()

    const result = parsePromptFiles([file!])

    if (!result.ok) throw new Error(`the prompt file is rejected: ${result.errors.join(' | ')}`)
    expect(result.prompts[0]).toMatchObject({ exportName: 'catalogDrafterDraftCatalogRowPrompt', job: 'draft-catalog-row', version: 'none' })
    expect(result.prompts[0]!.usedBy).toContain('AnthropicCatalogDrafter.draft')
    expect(result.prompts[0]!.body.trim()).not.toBe('')
  })

  it('is in the committed generated module, so the Worker and the drafter adapter can import it (run `npm run prompts`)', () => {
    const result = parsePromptFiles(promptFiles())
    if (!result.ok) throw new Error(`a prompt file is rejected: ${result.errors.join(' | ')}`)

    expect(readFileSync(path.join(PROMPTS_DIR, 'prompts.generated.ts'), 'utf8')).toBe(renderPromptsModule(result.prompts))
    expect(result.prompts.map((p) => p.file)).toContain(PROMPT_FILE)
  })
})

describe('package.json', () => {
  it('has a catalog:draft script that runs scripts/catalog-draft.ts', () => {
    const { scripts } = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> }

    expect(scripts['catalog:draft']).toBe('tsx scripts/catalog-draft.ts')
  })
})

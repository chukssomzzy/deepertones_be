import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AI_JOBS } from '../../src/providers/anthropic/ai-spend.provider'
import { parsePromptFiles, renderPromptsModule } from '../prompts/generate'
import { DEFAULT_MODELS } from './models'

// What `eval:catalog --mode draft` needs to exist besides its code: the AI job its judge runs under, the prompt behind it and the model it runs on.
// There was no eval-only judge job to reuse (same-product, split-name, read-goal and read-mentions are the product's own steps, and billing the judge to one of
// them would hide its cost in `npm run ai:spend`), so the judge has its own: judge-draft. It shares the cheap judge model variable, ANTHROPIC_MODEL_JUDGE.
const PROMPTS_DIR = path.resolve(import.meta.dirname, '../../src/prompts')
const PROMPT_FILE = 'draft-judge.judge-draft.md'

const promptFiles = () => readdirSync(PROMPTS_DIR).filter((name) => name.endsWith('.md')).map((name) => ({ name, content: readFileSync(path.join(PROMPTS_DIR, name), 'utf8') }))

describe('the judge-draft AI job', () => {
  it('is one of the AI jobs, so its calls are costed, capped and listed like every other', () => {
    expect(AI_JOBS).toContain('judge-draft')
  })

  it('runs on Haiku by default in the eval: it checks a page for a person who reads the result, it writes nothing a user reads', () => {
    expect((DEFAULT_MODELS as Record<string, string>)['judge-draft']).toBe('claude-haiku-5-5')
  })
})

describe(`src/prompts/${PROMPT_FILE}`, () => {
  it('exists, and is a valid prompt file for the judge-draft job used by the judge adapter', () => {
    const file = promptFiles().find((f) => f.name === PROMPT_FILE)
    expect(file, `${PROMPT_FILE} is missing from src/prompts`).toBeDefined()

    const result = parsePromptFiles([file!])

    if (!result.ok) throw new Error(`the prompt file is rejected: ${result.errors.join(' | ')}`)
    expect(result.prompts[0]).toMatchObject({ exportName: 'draftJudgeJudgeDraftPrompt', job: 'judge-draft', version: 'none' })
    expect(result.prompts[0]!.usedBy).toContain('AnthropicDraftJudge.judge')
    expect(result.prompts[0]!.body.trim()).not.toBe('')
  })

  it('treats the page as data: it says to ignore instructions that appear in it', () => {
    const body = promptFiles().find((f) => f.name === PROMPT_FILE)?.content ?? ''

    expect(body.toLowerCase()).toMatch(/ignore (any |all )?instructions/)
  })

  it('is in the committed generated module, so the judge adapter can import it (run `npm run prompts`)', () => {
    const result = parsePromptFiles(promptFiles())
    if (!result.ok) throw new Error(`a prompt file is rejected: ${result.errors.join(' | ')}`)

    expect(readFileSync(path.join(PROMPTS_DIR, 'prompts.generated.ts'), 'utf8')).toBe(renderPromptsModule(result.prompts))
    expect(result.prompts.map((p) => p.file)).toContain(PROMPT_FILE)
  })
})

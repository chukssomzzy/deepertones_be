import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AI_JOBS } from '../../src/providers/anthropic/ai-spend.provider'
import { parsePromptFiles, renderPromptsModule } from '../prompts/generate'
import { DEFAULT_MODELS } from './models'
import { PROBLEM_CODES } from './routine-judge'

// What the two judges of `eval:routine` need to exist besides their code: the AI jobs they run under, and the prompts behind them (which live in src/prompts, because
// the generator only reads there). Both jobs are eval-only and share the cheap judge model variable; the run moves judge-routine to Opus by itself.
const PROMPTS_DIR = path.resolve(import.meta.dirname, '../../src/prompts')
const files = () => readdirSync(PROMPTS_DIR).filter((name) => name.endsWith('.md')).map((name) => ({ name, content: readFileSync(path.join(PROMPTS_DIR, name), 'utf8') }))
const bodyOf = (name: string) => files().find((f) => f.name === name)?.content ?? ''

describe.each([
  { job: 'judge-routine', file: 'routine-judge.judge-routine.md', exportName: 'routineJudgeJudgeRoutinePrompt', usedBy: 'AnthropicRoutineJudge.judge' },
  { job: 'judge-grounding', file: 'routine-grounding-judge.judge-grounding.md', exportName: 'routineGroundingJudgeJudgeGroundingPrompt', usedBy: 'AnthropicGroundingJudge.judge' },
])('the $job AI job and src/prompts/$file', ({ job, file, exportName, usedBy }) => {
  it('is one of the AI jobs, so its calls are costed, capped and listed like every other, and runs on Haiku in the shared table', () => {
    expect(AI_JOBS).toContain(job)
    expect((DEFAULT_MODELS as Record<string, string>)[job]).toBe('claude-haiku-5-5')
  })

  it('has a prompt file that is valid for the job and names the adapter that uses it', () => {
    const found = files().find((f) => f.name === file)
    expect(found, `${file} is missing from src/prompts`).toBeDefined()

    const result = parsePromptFiles([found!])

    if (!result.ok) throw new Error(`the prompt file is rejected: ${result.errors.join(' | ')}`)
    expect(result.prompts[0]).toMatchObject({ exportName, job, version: 'none' })
    expect(result.prompts[0]!.usedBy).toContain(usedBy)
    expect(result.prompts[0]!.body.trim()).not.toBe('')
  })

  it('treats what it is shown as data: it says to ignore instructions that appear in it', () => {
    expect(bodyOf(file).toLowerCase()).toMatch(/ignore (any |all )?instructions/)
  })

  it('is in the committed generated module, so the adapter can import it (run `npm run prompts`)', () => {
    const result = parsePromptFiles(files())
    if (!result.ok) throw new Error(`a prompt file is rejected: ${result.errors.join(' | ')}`)

    expect(readFileSync(path.join(PROMPTS_DIR, 'prompts.generated.ts'), 'utf8')).toBe(renderPromptsModule(result.prompts))
    expect(result.prompts.map((p) => p.file)).toContain(file)
  })
})

describe('src/prompts/routine-judge.judge-routine.md: the rubric', () => {
  const body = () => bodyOf('routine-judge.judge-routine.md')

  it('lists every problem code the answer may use, so the judge cannot invent one', () => {
    for (const code of PROBLEM_CODES) expect(body(), code).toContain(code)
  })

  it('names the three classes of a pick and the three scores, and the 1 to 5 scale', () => {
    const text = body().toLowerCase()

    for (const word of ['best', 'acceptable', 'not', 'fit', 'simplicity', 'words']) expect(text, word).toContain(word)
    expect(text).toMatch(/\b1\b[\s\S]*\b5\b/)
  })

  it('states the rubric of each score: fit (kept shelf products first, a visible also-noticed concern as a tie-break, gentleness in a caution state, less weight on low-confidence readings), simplicity (steps and new products against what the goal needs) and words (true, plain and calm, honest about 8 to 12 weeks, ingredient terms explained)', () => {
    const text = body().toLowerCase()

    expect(text).toMatch(/shelf/)
    expect(text).toMatch(/also.noticed/)
    expect(text).toMatch(/caution/)
    expect(text).toMatch(/low.confidence/)
    expect(text).toMatch(/new products?/)
    expect(text).toMatch(/8 to 12 weeks/)
    expect(text).toMatch(/explain/)
  })
})

describe('src/prompts/routine-grounding-judge.judge-grounding.md: the page-support judge', () => {
  it('tells the judge to fetch the cited page only, once, and to answer from what the page says, not from memory', () => {
    const text = bodyOf('routine-grounding-judge.judge-grounding.md').toLowerCase()

    expect(text).toMatch(/web fetch/)
    expect(text).toMatch(/from memory/)
    expect(text).toMatch(/supports/)
    for (const word of ['yes', 'no', 'unclear']) expect(text, word).toContain(word)
  })
})

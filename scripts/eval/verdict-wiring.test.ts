import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// What `eval:verdict` and `eval:verdict:rescore` need to exist besides their cores: the two thin CLIs (scripts/eval-verdict.ts, scripts/eval-verdict-rescore.ts, wiring
// like scripts/eval-routine.ts) and the npm scripts that run them. A CLI runs `main()` the moment it is imported, so it cannot be driven from a test; what can be pinned
// without running it is that it exists, that npm runs it, and that the one that must never need a key does not reach for one.
const SCRIPTS_DIR = path.resolve(import.meta.dirname, '..')
const packageScripts = (): Record<string, string> => (JSON.parse(readFileSync(path.resolve(SCRIPTS_DIR, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

describe('the eval:verdict commands', () => {
  it.each([
    ['eval:verdict', 'scripts/eval-verdict.ts'],
    ['eval:verdict:rescore', 'scripts/eval-verdict-rescore.ts'],
  ])('npm run %s runs %s with tsx, as the other evals do', (script, file) => {
    expect(packageScripts()[script]).toBe(`tsx ${file}`)
    expect(existsSync(path.resolve(SCRIPTS_DIR, '..', file)), `${file} is missing`).toBe(true)
  })

  it('has a rescore that cannot need a key or make a call: it never reads the environment, builds a client or a ledger, or imports a provider', () => {
    const source = readFileSync(path.resolve(SCRIPTS_DIR, 'eval-verdict-rescore.ts'), 'utf8')

    for (const forbidden of ['loadEnv', 'ANTHROPIC_API_KEY', 'AnthropicClient', 'AnthropicVerdictFitter', 'MemoryAiSpendLedger', 'process.env']) expect(source, forbidden).not.toContain(forbidden)
  })

  it('has a run that wires the real fit judge and the spend ledger, where the rescore does not', () => {
    const source = readFileSync(path.resolve(SCRIPTS_DIR, 'eval-verdict.ts'), 'utf8')

    for (const wired of ['AnthropicVerdictFitter', 'AnthropicClient', 'MemoryAiSpendLedger', 'runVerdictEval', 'parseVerdictArgs']) expect(source, wired).toContain(wired)
  })
})

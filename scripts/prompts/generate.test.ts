import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { AI_JOBS } from '../../src/providers/anthropic/ai-spend.provider'
import { type ParsedPrompt, parsePromptFiles, renderPromptsModule } from './generate'

type InputFile = { name: string; content: string }

/** The front-matter fields of a valid prompt file; a test overrides or drops (undefined) only what it is about. */
type Fields = { purpose?: string; usedBy?: string; job?: string; version?: string; placeholders?: Record<string, string> }

const VALID: Fields = { purpose: 'Does a thing.', usedBy: 'AnthropicThing.run', job: 'analysis', version: 'none' }

/** A prompt file: `---`, the front matter, `---`, then the body exactly as given. */
const promptFile = (name: string, body: string, fields: Fields = {}): InputFile => {
  const { placeholders, ...scalars } = { ...VALID, ...fields }
  const lines = Object.entries(scalars)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value}`)
  if (placeholders !== undefined) {
    lines.push(Object.keys(placeholders).length === 0 ? 'placeholders: {}' : 'placeholders:')
    for (const [key, description] of Object.entries(placeholders)) lines.push(`  ${key}: ${description}`)
  }
  return { name, content: `---\n${lines.join('\n')}\n---\n${body}` }
}

/** Parses files that must all be valid. */
const parsed = (...files: InputFile[]): ParsedPrompt[] => {
  const result = parsePromptFiles(files)
  if (!result.ok) throw new Error(`expected the files to parse, got: ${result.errors.join(' | ')}`)
  return result.prompts
}

/** Parses files that must be rejected; returns the errors. */
const errorsOf = (...files: InputFile[]): string[] => {
  const result = parsePromptFiles(files)
  if (result.ok) throw new Error('expected the files to be rejected')
  return result.errors
}

const bodyOf = (content: string, name = 'thing.run.md') => parsed(promptFile(name, content))[0]!.body

// Known-good digests, computed outside the code under test (shasum -a 256).
const SHA256_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const SHA256_HI_NAME_PLACEHOLDER = 'deeba1bc3365b21a1114b846653b300411236d39777fb54653dad310e4b7d445' // "Hi {{name}}", unfilled

describe('parsePromptFiles body', () => {
  it('strips the front matter and keeps the body exactly', () => {
    const body = 'You are a helper.\n\n- Keep it short.\n  - Indented line  \n\nLast line.'

    expect(bodyOf(body)).toBe(body)
  })

  it('removes exactly one trailing newline', () => {
    expect(bodyOf('Body\n')).toBe('Body')
    expect(bodyOf('Body\n\n')).toBe('Body\n')
  })

  it('leaves a body with no trailing newline unchanged', () => {
    expect(bodyOf('Body')).toBe('Body')
  })

  it('strips nothing else: leading blank lines, indentation and trailing spaces stay', () => {
    expect(bodyOf('\n  Indented start\ntrailing space \n')).toBe('\n  Indented start\ntrailing space ')
  })

  it('keeps a --- line in the body, since the front matter ends at the first one', () => {
    expect(bodyOf('Before\n---\nAfter\n')).toBe('Before\n---\nAfter')
  })

  it('treats single braces as plain text, so JSON in a body is not a placeholder', () => {
    const body = 'Reply with:\n{"found": boolean, "ingredients": string[], "sourceUrl": string | null}'

    const [prompt] = parsed(promptFile('thing.run.md', body))

    expect(prompt!.body).toBe(body)
    expect(prompt!.placeholders).toEqual({})
  })

  it('does not send the front matter to the model: nothing of it is in the body', () => {
    const [prompt] = parsed(promptFile('thing.run.md', 'Body\n', { purpose: 'Notes only for people.' }))

    expect(prompt!.body).not.toContain('Notes only for people.')
    expect(prompt!.body).not.toContain('purpose')
  })
})

describe('parsePromptFiles metadata', () => {
  it('reads the front-matter fields and the placeholder descriptions', () => {
    const file = promptFile('product-analyst.analyse.md', 'Why: {{whyGuidance}}. Who: {{whoGuidance}}.\n', {
      purpose: 'Explain the concerns.',
      usedBy: 'AnthropicProductAnalyst.analyse',
      job: 'analysis',
      version: 'ANALYSIS_VERSION',
      placeholders: { whyGuidance: 'Length limit for why.', whoGuidance: 'Length limit for who.' },
    })

    expect(parsed(file)).toEqual([
      {
        file: 'product-analyst.analyse.md',
        exportName: 'productAnalystAnalysePrompt',
        purpose: 'Explain the concerns.',
        usedBy: 'AnthropicProductAnalyst.analyse',
        job: 'analysis',
        version: 'ANALYSIS_VERSION',
        placeholders: { whyGuidance: 'Length limit for why.', whoGuidance: 'Length limit for who.' },
        body: 'Why: {{whyGuidance}}. Who: {{whoGuidance}}.',
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ])
  })

  it.each([
    ['label-reader.read-label.md', 'labelReaderReadLabelPrompt'],
    ['product-recognizer.recognize.md', 'productRecognizerRecognizePrompt'],
    ['product-researcher.research.md', 'productResearcherResearchPrompt'],
    ['product-analyst.analyse.md', 'productAnalystAnalysePrompt'],
    ['product-analyst.same-product.md', 'productAnalystSameProductPrompt'],
    ['product-analyst.image-check.md', 'productAnalystImageCheckPrompt'],
  ])('names the export of %s %s', (name, exportName) => {
    expect(parsed(promptFile(name, 'Body\n'))[0]!.exportName).toBe(exportName)
  })

  it.each(AI_JOBS)('accepts the %s job', (job) => {
    expect(parsed(promptFile('thing.run.md', 'Body\n', { job }))[0]!.job).toBe(job)
  })

  it.each(['ANALYSIS_VERSION', 'none'])('accepts the %s version', (version) => {
    expect(parsed(promptFile('thing.run.md', 'Body\n', { version }))[0]!.version).toBe(version)
  })

  it('reads a prompt with no placeholders key, or an empty one, as having none', () => {
    expect(parsed(promptFile('a.one.md', 'Body\n'))[0]!.placeholders).toEqual({})
    expect(parsed(promptFile('a.two.md', 'Body\n', { placeholders: {} }))[0]!.placeholders).toEqual({})
  })

  it('returns the prompts sorted by file name, whatever order the files came in', () => {
    const files = [promptFile('c.third.md', 'C\n'), promptFile('a.first.md', 'A\n'), promptFile('b.second.md', 'B\n')]
    const expected = ['a.first.md', 'b.second.md', 'c.third.md']

    expect(parsed(...files).map((prompt) => prompt.file)).toEqual(expected)
    expect(parsed(...[...files].reverse()).map((prompt) => prompt.file)).toEqual(expected)
  })
})

describe('parsePromptFiles hash', () => {
  it('is the sha256 hex of the body: front matter stripped, trailing newline trimmed', () => {
    expect(parsed(promptFile('thing.run.md', 'hello\n'))[0]!.hash).toBe(SHA256_HELLO)
  })

  it('is taken before placeholders are filled', () => {
    const file = promptFile('thing.run.md', 'Hi {{name}}\n', { placeholders: { name: 'Who to greet.' } })

    expect(parsed(file)[0]!.hash).toBe(SHA256_HI_NAME_PLACEHOLDER)
  })

  it('changes when the body changes', () => {
    const before = parsed(promptFile('thing.run.md', 'Keep it short.\n'))[0]!.hash
    const after = parsed(promptFile('thing.run.md', 'Keep it brief.\n'))[0]!.hash

    expect(after).not.toBe(before)
  })

  it('does not change when only the front matter changes', () => {
    const before = parsed(promptFile('thing.run.md', 'Body\n', { purpose: 'One purpose.', usedBy: 'A.b', job: 'analysis', version: 'none' }))[0]!.hash
    const after = parsed(
      promptFile('thing.run.md', 'Body\n', { purpose: 'A different purpose.', usedBy: 'C.d', job: 'research', version: 'ANALYSIS_VERSION' }),
    )[0]!.hash

    expect(after).toBe(before)
  })
})

describe('parsePromptFiles errors', () => {
  it.each(['purpose', 'usedBy', 'job', 'version'] as const)('rejects a file with no %s, naming the file and the field', (field) => {
    const errors = errorsOf(promptFile('broken.file.md', 'Body\n', { [field]: undefined }))

    expect(errors.length).toBeGreaterThan(0)
    for (const error of errors) expect(error).toContain('broken.file.md')
    expect(errors.join('\n')).toContain(field)
  })

  it.each(['purpose', 'usedBy', 'job', 'version'] as const)('rejects a file with an empty %s, naming the file and the field', (field) => {
    const errors = errorsOf(promptFile('broken.file.md', 'Body\n', { [field]: '' }))

    expect(errors.length).toBeGreaterThan(0)
    for (const error of errors) expect(error).toContain('broken.file.md')
    expect(errors.join('\n')).toContain(field)
  })

  it('rejects a job that is not an AI job, naming the file and the bad value', () => {
    const errors = errorsOf(promptFile('broken.file.md', 'Body\n', { job: 'summarise' }))

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('broken.file.md')
    expect(errors[0]).toContain('summarise')
  })

  it('rejects a version that is neither ANALYSIS_VERSION nor none, naming the file and the bad value', () => {
    const errors = errorsOf(promptFile('broken.file.md', 'Body\n', { version: 'PROMPT_VERSION' }))

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('broken.file.md')
    expect(errors[0]).toContain('PROMPT_VERSION')
  })

  it('rejects a file without front matter, naming the file', () => {
    const errors = errorsOf({ name: 'bare.file.md', content: 'Just a body.\n' })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('bare.file.md')
  })

  it('rejects front matter that is never closed, naming the file', () => {
    const errors = errorsOf({ name: 'open.file.md', content: '---\npurpose: x\nusedBy: A.b\njob: analysis\nversion: none\nBody with no closing line\n' })

    expect(errors.length).toBeGreaterThan(0)
    for (const error of errors) expect(error).toContain('open.file.md')
  })

  it('reports a placeholder the body uses but the front matter does not list', () => {
    const errors = errorsOf(promptFile('broken.file.md', 'Hi {{name}} from {{place}}\n', { placeholders: { name: 'Who.' } }))

    for (const error of errors) expect(error).toContain('broken.file.md')
    expect(errors.join('\n')).toContain('place')
  })

  it('reports a placeholder the front matter lists but the body does not use', () => {
    const errors = errorsOf(promptFile('broken.file.md', 'Hi {{name}}\n', { placeholders: { name: 'Who.', unused: 'Never used.' } }))

    for (const error of errors) expect(error).toContain('broken.file.md')
    expect(errors.join('\n')).toContain('unused')
  })

  it('reports a listed placeholder on a body that has none', () => {
    const errors = errorsOf(promptFile('broken.file.md', 'No placeholders here.\n', { placeholders: { name: 'Who.' } }))

    expect(errors.join('\n')).toContain('name')
  })

  it('reports missing and extra names together, and not the names that match', () => {
    const file = promptFile('broken.file.md', '{{matching}} {{missingFromList}}\n', { placeholders: { matching: 'Fine.', extraInList: 'Unused.' } })

    const errors = errorsOf(file)

    for (const error of errors) expect(error).toContain('broken.file.md')
    const text = errors.join('\n')
    expect(text).toContain('missingFromList')
    expect(text).toContain('extraInList')
    expect(text).not.toContain('matching')
  })

  it('accepts a placeholder used more than once when it is listed once', () => {
    const file = promptFile('thing.run.md', '{{name}} and {{name}} again\n', { placeholders: { name: 'Who.' } })

    expect(parsed(file)[0]!.placeholders).toEqual({ name: 'Who.' })
  })

  it.each([
    ['an uppercase first letter', 'Hello {{Name}}\n'],
    ['a space in the name', 'Hello {{two words}}\n'],
    ['a digit first', 'Hello {{1st}}\n'],
    ['a dash in the name', 'Hello {{first-name}}\n'],
    ['an empty name', 'Hello {{}}\n'],
    ['an unclosed opening', 'Hello {{name\n'],
  ])('rejects a malformed placeholder with %s, naming the file', (_label, body) => {
    const errors = errorsOf(promptFile('broken.file.md', body))

    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join('\n')).toContain('broken.file.md')
  })

  it.each(['single.md', 'a.b.c.md', 'no-dots-at-all'])('rejects the file name %s, which is not <adapter>.<purpose>.md, naming the file', (name) => {
    const errors = errorsOf(promptFile(name, 'Body\n'))

    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join('\n')).toContain(name)
  })

  it('rejects two files that would produce the same export name, naming both', () => {
    const errors = errorsOf(promptFile('product-analyst.analyse.md', 'One\n'), promptFile('product.analyst-analyse.md', 'Two\n'))

    const text = errors.join('\n')
    expect(text).toContain('product-analyst.analyse.md')
    expect(text).toContain('product.analyst-analyse.md')
    expect(text).toContain('productAnalystAnalysePrompt')
  })

  it('collects the errors of every file, not just the first', () => {
    const badFiles = ['bad-job.file.md', 'no-purpose.file.md', 'bad-placeholder.file.md', 'no-front-matter.file.md']

    const errors = errorsOf(
      promptFile('good.file.md', 'Fine.\n'),
      promptFile('bad-job.file.md', 'Body\n', { job: 'nope' }),
      promptFile('no-purpose.file.md', 'Body\n', { purpose: undefined }),
      promptFile('bad-placeholder.file.md', 'Hello {{Bad}}\n'),
      { name: 'no-front-matter.file.md', content: 'Body\n' },
    )

    const text = errors.join('\n')
    for (const name of badFiles) expect(text).toContain(name)
    expect(text).not.toContain('good.file.md')
    for (const error of errors) expect(badFiles.some((name) => error.includes(name))).toBe(true)
  })

  it('collects every problem in one file, not just the first', () => {
    const errors = errorsOf(promptFile('broken.file.md', 'Body\n', { purpose: undefined, job: 'nope', version: 'later' }))

    const text = errors.join('\n')
    expect(text).toContain('purpose')
    expect(text).toContain('nope')
    expect(text).toContain('later')
  })
})

describe('parsePromptFiles front matter that cannot be read', () => {
  const FIELDS = 'purpose: x\nusedBy: A.b\njob: analysis\nversion: none'

  /** A prompt file with hand-written front matter, for shapes the `promptFile` helper cannot produce. */
  const rawFile = (name: string, frontMatter: string, body = 'Body\n'): InputFile => ({ name, content: `---\n${frontMatter}\n---\n${body}` })

  it('rejects a file with CRLF line endings, naming the file and saying why', () => {
    const { content } = promptFile('windows.file.md', 'Body\n')

    const errors = errorsOf({ name: 'windows.file.md', content: content.replace(/\n/g, '\r\n') })

    expect(errors.length).toBeGreaterThan(0)
    for (const error of errors) expect(error).toContain('windows.file.md')
    expect(errors.join('\n')).toMatch(/CRLF/i)
  })

  it('rejects a closing front-matter line with trailing spaces, naming the file and the front matter', () => {
    const errors = errorsOf({ name: 'spaced.file.md', content: `---\n${FIELDS}\n--- \nBody\n` })

    expect(errors.length).toBeGreaterThan(0)
    for (const error of errors) expect(error).toContain('spaced.file.md')
    expect(errors.join('\n')).toMatch(/front matter/i)
  })

  it('rejects front matter that is not valid YAML, naming the file and saying the YAML is invalid', () => {
    const errors = errorsOf(rawFile('syntax.file.md', 'purpose: [unclosed\nusedBy: A.b'))

    expect(errors.length).toBeGreaterThan(0)
    for (const error of errors) expect(error).toContain('syntax.file.md')
    expect(errors.join('\n')).toMatch(/YAML/)
    expect(errors.join('\n')).toMatch(/not valid|invalid/i)
  })

  it.each([
    ['a scalar', 'just some text'],
    ['a number', '42'],
    ['a list', '- purpose\n- usedBy'],
  ])('rejects front matter that is %s rather than a map of fields, naming the file', (_label, frontMatter) => {
    const errors = errorsOf(rawFile('shape.file.md', frontMatter))

    expect(errors.length).toBeGreaterThan(0)
    for (const error of errors) expect(error).toContain('shape.file.md')
  })

  it.each([
    ['job', '5'],
    ['purpose', 'true'],
    ['usedBy', '5'],
    ['version', 'true'],
  ])('rejects a non-string %s (%s), naming the file and the field', (field, value) => {
    const errors = errorsOf(promptFile('typed.file.md', 'Body\n', { [field]: value }))

    expect(errors.length).toBeGreaterThan(0)
    for (const error of errors) expect(error).toContain('typed.file.md')
    expect(errors.join('\n')).toContain(field)
  })

  it.each([
    ['a list', 'placeholders:\n  - name'],
    ['a string', 'placeholders: just some text'],
  ])('rejects placeholders that are %s rather than a map, naming the file and the field', (_label, placeholders) => {
    const errors = errorsOf(rawFile('listed.file.md', `${FIELDS}\n${placeholders}`))

    expect(errors.length).toBeGreaterThan(0)
    for (const error of errors) expect(error).toContain('listed.file.md')
    expect(errors.join('\n')).toContain('placeholders')
  })
})

/*
 * renderPromptsModule: the source is transpiled and imported, so the tests observe what the Worker
 * would see (the exported values), not how the source is formatted.
 */

/** Transpiles the generated TypeScript (type-only imports are erased) and imports the result. */
const load = async (source: string): Promise<Record<string, any>> => {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
  return import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(outputText)}`)
}

/** Parses the files, renders the module and imports it. */
const moduleOf = (...files: InputFile[]) => load(renderPromptsModule(parsed(...files)))

const TRICKY_BODY = [
  'Backtick `code` and ``double``.',
  'Interpolation look-alike: ${process.exit(1)} and $' + '{name}.',
  `Quotes: 'single' "double" and a lone ' or ".`,
  'Backslashes: C:\\path\\n and a literal \\n, \\u0041, \\\\ and a trailing \\',
  'Dollar patterns: $& $1 $$ $`',
  'Unicode: é ü 日本語 🙂, line separators \u2028 \u2029',
  'Tabs:\tx',
  '',
  '  - indented, with a blank line above',
  'JSON: {"found": boolean, "ingredients": string[]}',
].join('\n')

describe('renderPromptsModule', () => {
  it('starts with a header saying the file is generated by npm run prompts and must not be edited', () => {
    const source = renderPromptsModule(parsed(promptFile('thing.run.md', 'Body\n')))

    const header = source.trimStart().split('\n').slice(0, 6).join('\n')
    expect(source.trimStart().startsWith('//') || source.trimStart().startsWith('/*')).toBe(true)
    expect(header).toMatch(/npm run prompts/)
    expect(header).toMatch(/do not edit/i)
  })

  it('imports AiJob as a type only, so the prompts folder ships no runtime import', () => {
    const source = renderPromptsModule(parsed(promptFile('thing.run.md', 'Body\n')))

    expect(source).toMatch(/import type \{ AiJob \} from ['"]\.\.\/providers\/anthropic\/ai-spend\.provider['"]/)
    expect(source.match(/^\s*import\s/gm)).toHaveLength(1)
  })

  it('exposes a prompt without placeholders as its body in text, with its job and hash', async () => {
    const mod = await moduleOf(promptFile('label-reader.read-label.md', 'Read the label.\n\nBe exact.\n', { job: 'read-label' }))

    const prompt = mod.labelReaderReadLabelPrompt
    expect(prompt.text).toBe('Read the label.\n\nBe exact.')
    expect(prompt.job).toBe('read-label')
    expect(prompt.hash).toBe(parsed(promptFile('label-reader.read-label.md', 'Read the label.\n\nBe exact.\n'))[0]!.hash)
    expect(prompt.render).toBeUndefined()
  })

  it('exposes a prompt with placeholders as a render function that fills every one', async () => {
    const body = 'Why: {{whyGuidance}}. Who: {{whoGuidance}}. Longer text is rejected.\n'
    const placeholders = { whyGuidance: 'Limit for why.', whoGuidance: 'Limit for who.' }
    const mod = await moduleOf(promptFile('product-analyst.analyse.md', body, { job: 'analysis', version: 'ANALYSIS_VERSION', placeholders }))

    const prompt = mod.productAnalystAnalysePrompt
    expect(prompt.render({ whyGuidance: '2-3 sentences', whoGuidance: 'One sentence' })).toBe(
      'Why: 2-3 sentences. Who: One sentence. Longer text is rejected.',
    )
    expect(prompt.job).toBe('analysis')
    expect(prompt.hash).toBe(parsed(promptFile('product-analyst.analyse.md', body, { placeholders }))[0]!.hash)
    expect(prompt.text).toBeUndefined()
  })

  it('fills a placeholder everywhere it appears, at the start and end of the body, and next to another', async () => {
    const mod = await moduleOf(promptFile('thing.run.md', '{{a}}{{b}} middle {{a}}\n{{b}}\n', { placeholders: { a: 'A.', b: 'B.' } }))

    expect(mod.thingRunPrompt.render({ a: 'one', b: 'two' })).toBe('onetwo middle one\ntwo')
  })

  it('inserts values exactly, even when they look like replacement patterns, placeholders or template syntax', async () => {
    const mod = await moduleOf(promptFile('thing.run.md', 'Value: {{v}}.\n', { placeholders: { v: 'Any.' } }))

    for (const value of ['$&', '$1', '$$', '${x}', '`tick`', '{{v}}', 'a\\nb', "it's", '"q"', '']) {
      expect(mod.thingRunPrompt.render({ v: value })).toBe(`Value: ${value}.`)
    }
  })

  it('keeps a body of backticks, ${, quotes, backslashes and newlines exactly, without placeholders', async () => {
    const mod = await moduleOf(promptFile('thing.run.md', `${TRICKY_BODY}\n`))

    expect(mod.thingRunPrompt.text).toBe(TRICKY_BODY)
  })

  it('keeps a body of backticks, ${, quotes, backslashes and newlines exactly around placeholders', async () => {
    const body = `${TRICKY_BODY}\nMiddle {{v}} end\n${TRICKY_BODY}`
    const mod = await moduleOf(promptFile('thing.run.md', `${body}\n`, { placeholders: { v: 'Any.' } }))

    expect(mod.thingRunPrompt.render({ v: 'VALUE' })).toBe(`${TRICKY_BODY}\nMiddle VALUE end\n${TRICKY_BODY}`)
  })

  it('exposes one export per prompt, named from its file', async () => {
    const mod = await moduleOf(
      promptFile('product-analyst.same-product.md', 'Same?\n', { job: 'same-product' }),
      promptFile('product-analyst.image-check.md', 'Image?\n', { job: 'image-check' }),
    )

    expect(mod.productAnalystSameProductPrompt.text).toBe('Same?')
    expect(mod.productAnalystSameProductPrompt.job).toBe('same-product')
    expect(mod.productAnalystImageCheckPrompt.text).toBe('Image?')
    expect(mod.productAnalystImageCheckPrompt.job).toBe('image-check')
  })

  it('renders the same source whatever order the files came in', () => {
    const files = [
      promptFile('c.third.md', 'C {{x}}\n', { placeholders: { x: 'X.' } }),
      promptFile('a.first.md', 'A\n'),
      promptFile('b.second.md', TRICKY_BODY),
    ]

    const source = renderPromptsModule(parsed(...files))

    expect(renderPromptsModule(parsed(...[...files].reverse()))).toBe(source)
    expect(renderPromptsModule(parsed(files[1]!, files[2]!, files[0]!))).toBe(source)
    expect(renderPromptsModule(parsed(...files))).toBe(source)
  })

  it('changes the source when a body changes', () => {
    const before = renderPromptsModule(parsed(promptFile('thing.run.md', 'Keep it short.\n')))
    const after = renderPromptsModule(parsed(promptFile('thing.run.md', 'Keep it brief.\n')))

    expect(after).not.toBe(before)
  })

  it('does not put the front matter in the module', () => {
    const source = renderPromptsModule(parsed(promptFile('thing.run.md', 'Body\n', { purpose: 'Notes only for people.', usedBy: 'Secret.method' })))

    expect(source).not.toContain('Notes only for people.')
    expect(source).not.toContain('Secret.method')
  })
})

describe('renderPromptsModule types', () => {
  /** Typechecks the generated module plus a consumer, all in memory; returns the diagnostics as text. */
  const typecheck = (generated: string, consumer: string): string[] => {
    const files: Record<string, string> = {
      '/virtual/src/providers/anthropic/ai-spend.provider.ts': "export type AiJob = 'research' | 'analysis' | 'same-product' | 'image-check' | 'recognize' | 'read-label'\n",
      '/virtual/src/prompts/prompts.generated.ts': generated,
      '/virtual/consumer.ts': consumer,
    }
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.esnext.d.ts'],
      types: [],
    }
    const host = ts.createCompilerHost(options)
    const { fileExists, readFile, getSourceFile } = host
    host.fileExists = (path) => path in files || fileExists.call(host, path)
    host.readFile = (path) => files[path] ?? readFile.call(host, path)
    const { directoryExists } = host
    host.directoryExists = (path) => Object.keys(files).some((file) => file.startsWith(`${path}/`)) || (directoryExists?.call(host, path) ?? false)
    host.getSourceFile = (path, languageVersion, ...rest) =>
      path in files ? ts.createSourceFile(path, files[path]!, languageVersion) : getSourceFile.call(host, path, languageVersion, ...rest)
    const program = ts.createProgram(['/virtual/consumer.ts', '/virtual/src/prompts/prompts.generated.ts'], options, host)
    return ts.getPreEmitDiagnostics(program).map((d) => `${d.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
  }

  const source = () =>
    renderPromptsModule(
      parsed(
        promptFile('plain.run.md', 'No placeholders.\n', { job: 'research' }),
        promptFile('greet.run.md', 'Hi {{name}} from {{place}}\n', { job: 'analysis', placeholders: { name: 'Who.', place: 'Where.' } }),
      ),
    )

  it('types a prompt with placeholders as a function of exactly those names, so a missing, extra or misspelled value fails typecheck', () => {
    const consumer = `
import type { AiJob } from './src/providers/anthropic/ai-spend.provider'
import { greetRunPrompt, plainRunPrompt } from './src/prompts/prompts.generated'

const rendered: string = greetRunPrompt.render({ name: 'Ada', place: 'Lagos' })
const job: AiJob = greetRunPrompt.job
const hash: string = greetRunPrompt.hash

// @ts-expect-error a value is missing
greetRunPrompt.render({ name: 'Ada' })
// @ts-expect-error an extra value
greetRunPrompt.render({ name: 'Ada', place: 'Lagos', extra: 'x' })
// @ts-expect-error a misspelled value
greetRunPrompt.render({ name: 'Ada', plce: 'Lagos' })
// @ts-expect-error values are strings
greetRunPrompt.render({ name: 'Ada', place: 3 })

const text: string = plainRunPrompt.text
const plainJob: AiJob = plainRunPrompt.job
void [rendered, job, hash, text, plainJob]
`

    expect(typecheck(source(), consumer)).toEqual([])
  })
})

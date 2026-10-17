// The pure core of `npm run prompts`: prompt files in, the source of src/prompts/prompts.generated.ts out.
// No file system here, so the tests feed it in-memory files and the CLI (scripts/prompts.ts) does the I/O.
import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { AI_JOBS, type AiJob } from '../../src/providers/anthropic/ai-spend.provider'

const VERSIONS = ['ANALYSIS_VERSION', 'none'] as const
type PromptVersion = (typeof VERSIONS)[number]

export type ParsedPrompt = {
  file: string
  exportName: string
  purpose: string
  usedBy: string
  job: AiJob
  version: PromptVersion
  placeholders: Record<string, string>
  body: string
  hash: string
}

type ParseResult = { ok: true; prompts: ParsedPrompt[] } | { ok: false; errors: string[] }

const FILE_NAME = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.md$/
const PLACEHOLDER_NAME = /^[a-z][A-Za-z0-9]*$/
// Only valid placeholders reach this: a body with any other `{{` was rejected first.
const PLACEHOLDER = /\{\{([a-z][A-Za-z0-9]*)\}\}/

/** `product-analyst.analyse.md` becomes `productAnalystAnalysePrompt`. */
function exportNameOf(file: string): string {
  const [first = '', ...rest] = file.slice(0, -'.md'.length).split(/[.-]/)
  return `${first}${rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}Prompt`
}

/** The text between the opening `---` line and the next line that is exactly `---`, and everything after that line. */
function splitFrontMatter(content: string): { frontMatter: string; body: string } | undefined {
  if (!content.startsWith('---\n')) return undefined
  const rest = content.slice('---\n'.length)
  for (let lineStart = 0; lineStart <= rest.length; ) {
    const newline = rest.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? rest.length : newline
    if (rest.slice(lineStart, lineEnd) === '---') {
      return { frontMatter: rest.slice(0, lineStart), body: newline === -1 ? '' : rest.slice(newline + 1) }
    }
    if (newline === -1) return undefined
    lineStart = newline + 1
  }
  return undefined
}

/** The placeholder names the body uses, in order of first use, and every `{{` that is not a well-formed placeholder. */
function scanPlaceholders(body: string): { names: string[]; malformed: string[] } {
  const names: string[] = []
  const malformed: string[] = []
  for (let open = body.indexOf('{{'); open !== -1; ) {
    const close = body.indexOf('}}', open + 2)
    if (close === -1) {
      malformed.push(body.slice(open, open + 20))
      break
    }
    const name = body.slice(open + 2, close)
    if (PLACEHOLDER_NAME.test(name)) {
      if (!names.includes(name)) names.push(name)
    } else {
      malformed.push(body.slice(open, close + 2))
    }
    open = body.indexOf('{{', close + 2)
  }
  return { names, malformed }
}

function parseFile({ name, content }: { name: string; content: string }): { prompt?: ParsedPrompt; errors: string[] } {
  const errors: string[] = []
  const fail = (message: string) => errors.push(`${name}: ${message}`)

  if (!FILE_NAME.test(name)) fail('the file name must be <adapter>.<purpose>.md, lowercase, e.g. product-analyst.analyse.md')

  // Without this a CRLF file reports "missing front matter", because `---\r\n` is not `---\n`.
  if (content.includes('\r\n')) {
    fail('uses CRLF (Windows) line endings; save it with LF line endings')
    return { errors }
  }

  const parts = splitFrontMatter(content)
  if (!parts) {
    fail('missing front matter: the file must start with a --- line and close the front matter with another --- line')
    return { errors }
  }

  let meta: unknown
  try {
    meta = parse(parts.frontMatter) ?? {}
  } catch (error) {
    fail(`the front matter is not valid YAML (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`)
    return { errors }
  }
  if (typeof meta !== 'object' || Array.isArray(meta)) {
    fail('the front matter must be a map of fields')
    return { errors }
  }
  const fields = meta as Record<string, unknown>

  const text = (field: string): string | undefined => {
    const value = fields[field]
    if (typeof value === 'string' && value.trim() !== '') return value
    fail(`${field} is missing or empty`)
    return undefined
  }
  const purpose = text('purpose')
  const usedBy = text('usedBy')
  const job = text('job')
  const version = text('version')
  if (job !== undefined && !(AI_JOBS as readonly string[]).includes(job)) fail(`job "${job}" is not an AI job (${AI_JOBS.join(', ')})`)
  if (version !== undefined && !(VERSIONS as readonly string[]).includes(version)) fail(`version "${version}" must be ANALYSIS_VERSION or none`)

  const listed = fields.placeholders ?? {}
  const placeholders: Record<string, string> = {}
  if (typeof listed !== 'object' || listed === null || Array.isArray(listed)) {
    fail('placeholders must be a map from each placeholder name to a one-line description')
  } else {
    for (const [key, description] of Object.entries(listed)) {
      if (typeof description === 'string' && description.trim() !== '') placeholders[key] = description
      else fail(`placeholder "${key}" needs a one-line description`)
    }
  }

  const body = parts.body.endsWith('\n') ? parts.body.slice(0, -1) : parts.body
  const { names, malformed } = scanPlaceholders(body)
  for (const bad of malformed) fail(`malformed placeholder "${bad}": use {{name}} with a camelCase name`)
  const unlisted = names.filter((used) => !(used in placeholders))
  const unused = Object.keys(placeholders).filter((key) => !names.includes(key))
  if (unlisted.length > 0) fail(`placeholders used in the body but not listed in the front matter: ${unlisted.join(', ')}`)
  if (unused.length > 0) fail(`placeholders listed in the front matter but not used in the body: ${unused.join(', ')}`)

  if (errors.length > 0) return { errors }
  return {
    errors,
    prompt: {
      file: name,
      exportName: exportNameOf(name),
      purpose: purpose!,
      usedBy: usedBy!,
      job: job as AiJob,
      version: version as PromptVersion,
      placeholders,
      body,
      hash: createHash('sha256').update(body).digest('hex'),
    },
  }
}

/** Validates every file and returns the prompts sorted by file name, or every error found. */
export function parsePromptFiles(files: { name: string; content: string }[]): ParseResult {
  const errors: string[] = []
  const prompts: ParsedPrompt[] = []
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const result = parseFile(file)
    errors.push(...result.errors)
    if (result.prompt) prompts.push(result.prompt)
  }

  const byExportName = new Map<string, string[]>()
  for (const { file, exportName } of prompts) byExportName.set(exportName, [...(byExportName.get(exportName) ?? []), file])
  for (const [exportName, sharing] of byExportName) {
    if (sharing.length > 1) errors.push(`${sharing.join(' and ')}: both would export ${exportName}`)
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, prompts }
}

// JSON.stringify output is a valid JS string literal, so backticks, `${`, quotes and backslashes in a body are safe.
// The two line separators are legal in a literal since ES2019 but invisible in an editor, so they are written out.
const literal = (value: string) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

function renderPrompt({ exportName, job, hash, body, placeholders }: ParsedPrompt): string {
  const names = Object.keys(placeholders)
  const head = `export const ${exportName} = {\n  job: ${literal(job)},\n  hash: ${literal(hash)},\n`
  if (names.length === 0) {
    return `${head}  text: ${literal(body)},\n} as const satisfies { job: AiJob; hash: string; text: string }`
  }
  const parameter = `{ ${names.map((name) => `${name}: string`).join('; ')} }`
  const pieces = body
    .split(new RegExp(PLACEHOLDER, 'g'))
    .map((piece, index) => (index % 2 === 1 ? `values.${piece}` : piece === '' ? undefined : literal(piece)))
    .filter((piece) => piece !== undefined)
  return `${head}  render: (values: ${parameter}) => ${pieces.join(' + ')},\n} as const satisfies { job: AiJob; hash: string; render: (values: never) => string }`
}

/** The full source of src/prompts/prompts.generated.ts. */
export function renderPromptsModule(prompts: ParsedPrompt[]): string {
  const header =
    '// Generated by `npm run prompts` from the Markdown files in this folder. Do not edit: change the .md file and run it again.\n' +
    '// CI regenerates this file and fails if the committed one differs.\n' +
    "import type { AiJob } from '../providers/anthropic/ai-spend.provider'\n"
  const sorted = [...prompts].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return `${header}\n${sorted.map(renderPrompt).join('\n\n')}\n`
}

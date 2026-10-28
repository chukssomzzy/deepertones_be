// Writes docs/catalog-workbook-contract.md from the workbook contract: `npm run catalog:contract-doc`.
// Commit the result. The file is for the people who fill the workbook in, so it is never edited by hand, and a test fails when it is older than
// the contract (the way CI fails a stale docs/openapi.json).
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  CONTRACT,
  contractFingerprint,
  type ColumnDefinition,
  type RuleCode,
  type TabDefinition,
} from '../src/modules/catalog/catalog.workbook.schema'

const OUTPUT = 'docs/catalog-workbook-contract.md'

/** A table cell: a pipe would end it, and a line break would end the row. */
const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ')

const code = (text: string): string => `\`${text}\``

/** The name of a vocabulary as a heading: `shownConcerns` is "Shown concerns". */
const titleOf = (name: string): string => {
  const words = name.replace(/([A-Z])/g, ' $1').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const NEEDED: Record<ColumnDefinition['required'], string> = {
  always: 'Required',
  'unless-retired': 'Required, unless the row is retired',
  'when-approved': 'Required when approved',
  optional: 'Optional',
}

/** The format and limits of a column, as short sentences: its format first, then its limits. */
const holds = (column: ColumnDefinition): string => {
  const parts: string[] = []
  switch (column.type) {
    case 'text':
      parts.push('Text')
      break
    case 'list':
      parts.push('List, items separated by semicolons')
      break
    case 'inci':
      parts.push('An ingredient name, normalised')
      break
    case 'inci-list':
      parts.push('List of ingredient names, separated by semicolons, each normalised')
      break
    case 'vocabulary':
      parts.push(`One of: ${CONTRACT.vocabularies[column.vocabulary!].map(code).join(', ')}`)
      break
    case 'vocabulary-list':
      parts.push(`One or more of, separated by semicolons: ${CONTRACT.vocabularies[column.vocabulary!].map(code).join(', ')}`)
      break
    case 'url':
      parts.push('An https link')
      break
    case 'url-list':
      parts.push('List of https links, separated by semicolons')
      break
    case 'date':
      parts.push(`A day written ${code(CONTRACT.cells.dateFormat)}`)
      break
    case 'integer':
      parts.push('A whole number, zero or more')
      break
    case 'pattern':
      parts.push(column.patternAbout!)
      break
    case 'reference':
      parts.push(`A ${code(column.refersTo!.column)} from the ${titleOf(column.refersTo!.tab)} tab, written exactly`)
      break
    case 'draft-cells':
      parts.push('List of column=https-link pairs, separated by semicolons')
      break
    case 'schedule':
    case 'ladder':
      parts.push(`Steps separated by semicolons, each ${code('<weeks>: <frequency>')}, the frequency one of: ${CONTRACT.vocabularies[column.vocabulary!].map(code).join(', ')}`)
      break
  }
  if (column.exclusive !== undefined) parts.push(`${code(column.exclusive)} only on its own, never next to another value`)
  if (column.maxLength !== undefined) parts.push(`Up to ${column.maxLength} characters`)
  if (column.maxItems !== undefined) parts.push(`1 to ${column.maxItems} items`)
  if (column.itemMaxLength !== undefined) parts.push(`Each item up to ${column.itemMaxLength} characters`)
  if (column.plainText) parts.push('No links or markup')
  if (column.lowerCase) parts.push('Lower case only')
  if (column.stepPlaceholder) parts.push(`${code('{step}')} is the only placeholder allowed`)
  if (column.routineWording) parts.push('No condition names, diagnoses, or promises of lighter, fairer or whiter skin')
  if (column.unique) parts.push('Unique in the tab')
  if (column.draftable === false) parts.push('Cannot be a draft cell')
  return `${parts.join('. ')}.`
}

/** The problem codes a column's own cells can raise. */
const rulesOf = (column: ColumnDefinition): RuleCode[] => {
  const rules: RuleCode[] = []
  if (column.required === 'when-approved') rules.push('REQUIRED_WHEN_APPROVED')
  else if (column.required !== 'optional') rules.push('REQUIRED')
  switch (column.type) {
    case 'text':
      if (column.maxLength !== undefined) rules.push('TOO_LONG')
      if (column.plainText) rules.push('HAS_LINK_OR_MARKUP')
      if (column.lowerCase) rules.push('NOT_LOWER_CASE')
      if (column.stepPlaceholder) rules.push('RESPONSE_PLACEHOLDER')
      if (column.routineWording) rules.push(column.wordingRule ?? 'GUIDE_WORDING')
      break
    case 'list':
      if (column.maxItems !== undefined) rules.push('TOO_MANY_ITEMS')
      if (column.itemMaxLength !== undefined) rules.push('ITEM_TOO_LONG')
      if (column.plainText) rules.push('HAS_LINK_OR_MARKUP')
      break
    case 'inci':
      if (column.maxLength !== undefined) rules.push('TOO_LONG')
      rules.push('NOT_NORMALISED')
      break
    case 'inci-list':
      if (column.itemMaxLength !== undefined) rules.push('ITEM_TOO_LONG')
      rules.push('NOT_NORMALISED')
      break
    case 'vocabulary':
    case 'vocabulary-list':
      rules.push('NOT_IN_VOCABULARY')
      break
    case 'url':
    case 'url-list':
      rules.push('NOT_HTTPS_URL')
      break
    case 'date':
      rules.push('BAD_DATE')
      break
    case 'integer':
      rules.push('NOT_A_WHOLE_NUMBER')
      break
    case 'pattern':
      rules.push(column.patternRule!)
      break
    case 'reference':
      rules.push(column.refersTo!.rule)
      break
    case 'draft-cells':
      rules.push('INVALID_DRAFT_CELL', 'DRAFT_CELL_COLUMN', 'NOT_HTTPS_URL')
      break
    case 'schedule':
      rules.push('TOO_LONG', 'BAD_SCHEDULE', 'SCHEDULE_NOT_CONTIGUOUS', 'SCHEDULE_MISSING_STOP', 'SCHEDULE_STOP_NOT_LAST', 'SCHEDULE_FREQUENCY_INCREASES')
      break
    case 'ladder':
      rules.push('TOO_LONG', 'BAD_SCHEDULE', 'SCHEDULE_NOT_CONTIGUOUS', 'REINTRO_MISSING_BACK', 'REINTRO_BACK_ONLY', 'REINTRO_BACK_NOT_LAST', 'REINTRO_FREQUENCY_DECREASES')
      break
  }
  if (column.exclusive !== undefined) rules.push('ALL_MIXED_WITH_OTHERS')
  if (column.name.startsWith('audited_')) rules.push('AUDIT_INCOMPLETE')
  if (column.unique) rules.push('DUPLICATE_CODE')
  return rules
}

const tabSection = (tab: TabDefinition): string => {
  const rows = tab.columns.map(
    (column) => `| ${code(column.name)} | ${NEEDED[column.required]} | ${cell(column.about)} | ${cell(holds(column))} | ${rulesOf(column).map(code).join(' ')} |`,
  )
  const checks = tab.checks.map((check) => `- ${code(check.rule)}: ${check.about}`)
  return [
    `### ${tab.title}`,
    '',
    tab.about,
    '',
    '| Column | Needed | What it holds | Format and accepted values | Problems it can raise |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    'Checks across cells and rows:',
    '',
    ...checks,
    '',
  ].join('\n')
}

const vocabularySection = (): string => {
  const usedBy = (name: string) =>
    CONTRACT.tabs.flatMap((tab) => tab.columns.filter((column) => column.vocabulary === name).map((column) => `${tab.title}.${column.name}`))
  const words: Record<string, Record<string, string> | undefined> = CONTRACT.vocabularyWords
  const notes: Record<string, string | undefined> = CONTRACT.vocabularyNotes
  return Object.entries(CONTRACT.vocabularies)
    .map(([name, values]) => {
      const used = usedBy(name)
      const meanings = words[name]
      return [
        `### ${titleOf(name)}`,
        '',
        ...(meanings === undefined ? [values.map(code).join(', ')] : values.map((value) => `- ${code(value)}: ${meanings[value]}`)),
        ...(notes[name] === undefined ? [] : ['', notes[name]!]),
        ...(used.length > 0 ? ['', `Used by: ${used.map(code).join(', ')}`] : []),
        '',
      ].join('\n')
    })
    .join('\n')
}

/** The whole document. The same contract always gives the same text. */
export const renderContractDoc = async (): Promise<string> =>
  [
    '# Catalog workbook contract',
    '',
    `Version ${CONTRACT.version}. Fingerprint ${code(await contractFingerprint())}.`,
    '',
    'This document is written by `npm run catalog:contract-doc` from `src/modules/catalog/catalog.workbook.schema.ts`. Do not edit it by hand: change the',
    'contract, and run the command again.',
    '',
    '## How the workbook is read',
    '',
    'The workbook has eleven tabs: Products, Availability, Ingredients, Countries, Claim words, Tapers, Guides, Reintroductions, Escalations, Responses and Weeks. The first row of a tab is its header: one column name for each',
    'column below, spelled exactly as written here. Every column is needed in the header, even one whose cells may stay empty, and a column that is not',
    'listed here is a problem. A tab with no rows is fine, but it still needs its header row.',
    '',
    `- A list is written in one cell, its items separated by ${code(CONTRACT.cells.listSeparator)}. Spaces around an item are ignored, and so is an empty item.`,
    `- A date is written ${code(CONTRACT.cells.dateFormat)}, as text.`,
    `- ${CONTRACT.cells.text}`,
    '- A link is an https web address of a public website.',
    '- Every problem found is listed, never only the first. A problem names the tab, the row, the column and a problem code, and never repeats what the cell',
    '  held. Row 1 is the header and the first row of data is row 2, as the spreadsheet numbers them. A problem on the header row is about a column as a',
    '  whole, and where two rows clash, both rows are listed.',
    '',
    '## Tabs',
    '',
    CONTRACT.tabs.map(tabSection).join('\n'),
    '## Accepted values',
    '',
    'A value is accepted only when written exactly as here, in lower case.',
    '',
    vocabularySection(),
    '## Problem codes',
    '',
    '| Code | What it means |',
    '| --- | --- |',
    ...Object.entries(CONTRACT.rules).map(([rule, meaning]) => `| ${code(rule)} | ${cell(meaning)} |`),
    '',
  ].join('\n')

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(OUTPUT, await renderContractDoc())
  console.log(`wrote ${OUTPUT}`)
}

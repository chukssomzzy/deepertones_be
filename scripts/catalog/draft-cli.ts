// The shell of `npm run catalog:draft` without the process: argv in, lines out through `log` and `error`, an exit code back. The real effects (the key, the
// Claude clients, the files, the terminal) are handed in by scripts/catalog-draft.ts.
import type { DraftDeps, DraftIo } from './draft'
import { formatReport, runDraft } from './draft'
import { parseArgs } from './draft-args'
import { DraftInputError } from './draft-input-error'
import { WorkbookFileError } from './xlsx'

export type DraftCliDeps = {
  /** Rejects with a DraftInputError when the key is missing, which is the person's to fix; any other rejection is hidden. */
  loadApiKey: () => Promise<string>
  /** The researcher, the drafter and the ledger they spend on, capped at `maxUsd`. */
  clients: (settings: { apiKey: string; maxUsd: number }) => Omit<DraftDeps, 'countries' | 'passes'>
  io: DraftIo
  log: (line: string) => void
  error: (line: string) => void
}

/**
 * What to print for a failure. Only the errors made for the person's own mistakes are worded; the message of any other can hold a path, a cell, a key
 * or what Claude said, so it gets its class name, or UnknownError for a value that is not an Error at all (a string, null).
 */
const describeFailure = (error: unknown): string => {
  if (error instanceof DraftInputError || error instanceof WorkbookFileError) return error.message
  return `The draft stopped on an unexpected ${error instanceof Error ? error.name : 'UnknownError'}. Nothing was written unless the line above says so.`
}

/** Exit: 0 drafted with nothing left to fix, or nothing to draft; 1 a problem, a failed product or the cap remains (the file is written all the same); 2 the run could not start or Claude refused our key, billing or permissions. */
export async function draftCli(argv: string[], deps: DraftCliDeps): Promise<number> {
  let args: ReturnType<typeof parseArgs>
  let apiKey: string
  try {
    args = parseArgs(argv)
    apiKey = await deps.loadApiKey()
  } catch (error) {
    deps.error(describeFailure(error))
    return 2
  }

  try {
    const outcome = await runDraft(args, { ...deps.clients({ apiKey, maxUsd: args.maxUsd }), io: deps.io, notify: deps.log })
    if (outcome.draftRows === 0) return 0
    deps.log(formatReport(outcome))
    deps.log(`Wrote ${args.out}`)
    if (outcome.stoppedBy === 'config') return 2
    return outcome.problems.length > 0 || outcome.failed.length > 0 || outcome.stoppedBy === 'cap' ? 1 : 0
  } catch (error) {
    deps.error(describeFailure(error))
    return 2
  }
}

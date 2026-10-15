// Prints what the AI calls cost, read from the ai_usage table: `npm run ai:spend -- --env staging`.
//   --env local|staging|production   (default local)    --days N   how far back (default 30)
// Reads through `wrangler d1 execute` (so it needs `wrangler login` for staging and production) and changes nothing.
// Exit: 0 printed, 1 could not read or bad arguments.
import { execFileSync } from 'node:child_process'
import { buildQuery, formatSpend, parseSpendArgs, type SpendRow } from './ai-spend/spend'

const DAY = 24 * 60 * 60 * 1000

const main = (): number => {
  let args
  try {
    args = parseSpendArgs(process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    return 1
  }

  const now = new Date()
  const query = buildQuery(now.getTime() - args.days * DAY)
  const target = args.env === 'local' ? ['--local'] : ['--env', args.env, '--remote']
  let rows: SpendRow[]
  try {
    // An argument array and no shell, so the query is not re-quoted on its way to wrangler.
    const output = execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', ...target, '--json', '--command', query], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    rows = (JSON.parse(output) as { results: SpendRow[] }[])[0]?.results ?? []
  } catch {
    console.error(`Could not read ai_usage from the ${args.env} database. Is it migrated, and are you logged in to Cloudflare?`)
    return 1
  }
  console.log(formatSpend(rows, now, args.days))
  return 0
}

process.exitCode = main()

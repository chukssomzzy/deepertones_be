import { defineConfig } from 'drizzle-kit'

// `npm run db:generate` diffs every *.table.ts under src (modules and jobs) against the last snapshot and
// writes a new SQL migration. It only generates; wrangler applies (db:migrate:*).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/**/*.table.ts',
  // Must match `migrations_dir` in wrangler.jsonc (all three environments).
  out: './migrations',
})

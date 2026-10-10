import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// Every integration test file starts from a database with all migrations applied.
// Already-applied migrations are skipped, so this is cheap after the first file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)

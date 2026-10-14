/**
 * Send one environment's secrets to its Worker.
 *
 * A deployed environment is one Worker (the queue consumer is the same Worker), with its own
 * secret store. Secrets belong to a Worker's name, are not shared between environments, and a
 * Worker missing one does not fail at deploy unless it is in `secrets.required`: it fails at the
 * first request that needed it. So the list lives as data in scripts/secrets/plan.ts, next to the
 * reason for each entry, and this script refuses a name it does not recognise instead of guessing.
 *
 *   npm run secrets:push -- --env staging
 *   npm run secrets:push -- --env staging --apply
 *
 * Without `--apply` it reports what it would send and sends nothing. Values are never printed,
 * never logged and never written to disk: the file is read into memory and piped to
 * `wrangler secret bulk` over stdin.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { findDuplicateKeys, parseArgs, parseEnvFile, planSecretPush, wranglerBulkArgs, type TargetEnvironment } from './secrets/plan'

function main(): number {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    return 1
  }
  const target: TargetEnvironment = parsed.environment
  const apply = parsed.apply
  const other: TargetEnvironment = target === 'staging' ? 'production' : 'staging'

  const file = `.dev.vars.${target}`
  if (!existsSync(file)) {
    console.error(
      `${file} does not exist. Copy .dev.vars.deployed.example to it and fill it in. It is gitignored and must stay that way.`,
    )
    return 1
  }
  const otherFile = `.dev.vars.${other}`
  const contents = readFileSync(file, 'utf8')
  const plan = planSecretPush({
    values: parseEnvFile(contents),
    duplicates: findDuplicateKeys(contents),
    // Read only so the pepper check can compare; nothing from it is printed or sent.
    otherEnvironment: existsSync(otherFile) ? parseEnvFile(readFileSync(otherFile, 'utf8')) : undefined,
  })

  const names = Object.keys(plan.send).sort()
  console.log(`\n${file} → ${target}\n`)
  console.log(`  Will send (${names.length}):`)
  for (const name of names) console.log(`    → ${name}`)

  if (plan.skipped.length > 0) {
    console.log('\n  Not a secret, skipped:')
    for (const { name, reason } of plan.skipped) console.log(`    · ${name}: ${reason}`)
  }
  if (plan.blank.length > 0) {
    console.log('\n  Blank, so left alone on the Worker (a blank never overwrites):')
    for (const name of plan.blank) console.log(`    ? ${name}`)
  }
  if (plan.missingRequired.length > 0) {
    console.log(
      `\n  Warning: required but not in this push: ${plan.missingRequired.join(', ')}.\n  Deploys fail until these are set on the Worker; if they already are, ignore.`,
    )
  }
  if (!existsSync(otherFile)) console.log(`\n  OTP_PEPPER not compared: ${otherFile} not found`)
  if (plan.errors.length > 0) {
    console.log('\n  Errors, nothing sent:')
    for (const error of plan.errors) console.log(`    ✖ ${error}`)
    return 1
  }

  if (!apply) {
    console.log('\nNothing sent. Re-run with --apply.\n')
    return 0
  }
  if (names.length === 0) {
    console.log('\nNothing to send.\n')
    return 0
  }

  // Over stdin rather than a file: a temporary file holding every credential for an environment
  // is a thing that outlives a crash.
  try {
    execFileSync('npx', wranglerBulkArgs(target), {
      input: JSON.stringify(plan.send),
      stdio: ['pipe', 'inherit', 'inherit'],
    })
  } catch {
    console.error('wrangler secret bulk failed (see output above)')
    return 1
  }
  console.log(`\nDone. ${names.length} secret(s) set on the ${target} Worker. Deploys never touch them.\n`)
  return 0
}

process.exitCode = main()

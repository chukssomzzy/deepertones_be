/**
 * The decisions behind `npm run secrets:push`, kept apart from the CLI so they can be tested
 * without a file system or a Cloudflare account. Nothing here reads a file, prints, or sends.
 */

export type TargetEnvironment = 'staging' | 'production'

export interface SecretSpec {
  /** Which module reads it, so a future reader can check rather than trust. */
  reason: string
  /** Mirrors `secrets.required` in wrangler.jsonc; a test fails if the two drift. */
  required: boolean
}

/**
 * Every secret a deployed environment holds. The Worker is one per environment (the queue
 * consumer is the same Worker), so there is no per-Worker split to record: a name is either
 * here, or it is config, or the push refuses it.
 */
export const SECRETS: Record<string, SecretSpec> = {
  ZEPTOMAIL_API_KEY: {
    reason: 'src/container.ts passes it to ZeptoMailEmailSender, which authorises every email send.',
    required: true,
  },
  OTP_PEPPER: {
    reason:
      'OtpService mixes it into stored code hashes, and the delivery queue seals the code in flight with it. Must differ between environments.',
    required: true,
  },
  JWT_SECRET: {
    reason:
      'TokenService signs and verifies access and refresh tokens with it. Must differ between environments. Rotate by moving the old value to JWT_SECRET_PREVIOUS.',
    required: true,
  },
  JWT_SECRET_PREVIOUS: {
    reason: 'TokenService still accepts tokens signed with it, for verification only, during a JWT_SECRET rotation.',
    required: false,
  },
  DEVICE_ID_KEY: {
    reason:
      'The auth flow keys the hash of each device id with it. NEVER rotate: rotating orphans every device\'s guest.',
    required: true,
  },
  WHATSAPP_ACCESS_TOKEN: {
    reason:
      'MetaWhatsAppOtpDelivery calls the Meta Cloud API with it. Optional until whatsapp is in OTP_CHANNELS.',
    required: false,
  },
  ANTHROPIC_API_KEY: {
    reason: 'src/container.ts builds the AnthropicClient with it, for product research and analysis.',
    required: true,
  },
  EXPO_ACCESS_TOKEN: {
    reason:
      'ExpoPushSender sends push notifications with it. Enhanced push security must be on in Expo, which then refuses sends without it.',
    required: true,
  },
  PERFECT_CORP_API_KEY: {
    reason:
      'RestPerfectCorpClient authorises every Perfect Corp (YouCam) call with it, for the face scan.',
    required: true,
  },
  PERFECT_CORP_WEBHOOK_SECRET: {
    reason:
      'RestPerfectCorpClient verifies the Standard Webhooks signature of every Perfect Corp webhook with it.',
    required: true,
  },
}

const VAR = 'a var in wrangler.jsonc; a secret of the same name is shadowed on deploy'

/**
 * Names that appear in a .dev.vars file but must never be sent as secrets: every `vars` key in
 * wrangler.jsonc. A test fails if one is added there and not here.
 */
export const NOT_SECRETS: Record<string, string> = {
  ENVIRONMENT: VAR,
  CORS_ORIGINS: VAR,
  DOCS_ENABLED: VAR,
  OTP_CHANNELS: VAR,
  EMAIL_FROM_ADDRESS: VAR,
  EMAIL_FROM_NAME: VAR,
  ZEPTOMAIL_API_URL: VAR,
  WHATSAPP_PHONE_NUMBER_ID: VAR,
  WHATSAPP_OTP_TEMPLATE: VAR,
  WHATSAPP_OTP_LANGUAGE: VAR,
  ANTHROPIC_MODEL_RESEARCH: VAR,
  ANTHROPIC_MODEL_VISION: VAR,
  ANTHROPIC_MODEL_RECOGNIZE_SHELF: VAR,
  ANTHROPIC_MODEL_JUDGE: VAR,
  ANTHROPIC_MODEL_ANALYSIS: VAR,
  AI_DAILY_BUDGET_USD: VAR,
  OPS_ALERT_EMAIL: VAR,
  CATALOG_IMAGES_PUBLIC_URL: VAR,
  PERFECT_CORP_BASE_URL: VAR,
  PERFECT_CORP_USD_PER_UNIT: VAR,
}

/**
 * One value, the way dotenv (and so wrangler) reads it: a matching pair of quotes is stripped, and
 * what follows the closing quote may only be a comment. Unquoted, whitespace then `#` starts a
 * comment; a `#` with no whitespace before it is part of the value, as is any `#` inside quotes.
 */
function parseValue(raw: string): string {
  const quote = raw[0]
  if (raw.length > 1 && (quote === '"' || quote === "'")) {
    const close = raw.lastIndexOf(quote)
    const rest = raw.slice(close + 1)
    if (close > 0 && (rest.trim() === '' || /^\s+#/.test(rest))) return raw.slice(1, close)
  }
  return raw.replace(/\s+#.*$/, '')
}

/** Names that appear on more than one line. The Map keeps the last, so the plan must be told. */
export function findDuplicateKeys(contents: string): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    const separator = trimmed.indexOf('=')
    if (trimmed.startsWith('#') || separator === -1) continue
    const key = trimmed.slice(0, separator).trim()
    if (seen.has(key)) duplicates.add(key)
    seen.add(key)
  }
  return [...duplicates].sort()
}

/**
 * Parses the `KEY=VALUE` form `.dev.vars` uses. Deliberately small: no interpolation, no
 * multi-line values, and `export X=1` is read literally as the key `export X`, which the plan then
 * rejects as unknown. Each of those is a silent misread if "supported" half-way.
 */
export function parseEnvFile(contents: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator === -1) continue
    const key = trimmed.slice(0, separator).trim()
    values.set(key, parseValue(trimmed.slice(separator + 1).trim()))
  }
  return values
}

export interface SecretPushPlan {
  /** Name to value: the only place a value lives. Never print this. */
  send: Record<string, string>
  skipped: { name: string; reason: string }[]
  blank: string[]
  unknown: string[]
  missingRequired: string[]
  errors: string[]
}

export function planSecretPush(input: {
  values: Map<string, string>
  /** The other environment's file, if it exists, only to check the peppers differ. */
  otherEnvironment?: Map<string, string>
  /** From findDuplicateKeys on the file being pushed. */
  duplicates?: string[]
}): SecretPushPlan {
  const { values, otherEnvironment, duplicates = [] } = input
  const send: Record<string, string> = {}
  const skipped: SecretPushPlan['skipped'] = []
  const blank: string[] = []
  const unknown: string[] = []

  for (const [name, value] of values) {
    if (name in NOT_SECRETS) {
      skipped.push({ name, reason: NOT_SECRETS[name]! })
    } else if (!(name in SECRETS)) {
      unknown.push(name)
    } else if (value === '') {
      // A blank is not a value: sending it would overwrite a credential already set correctly on
      // the Worker with an empty string, and it would look like success.
      blank.push(name)
    } else {
      send[name] = value
    }
  }

  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  skipped.sort((a, b) => byName(a.name, b.name))
  blank.sort(byName)
  unknown.sort(byName)

  // Absent and blank both count: either way this push will not set it. A warning rather than an
  // error, because it may already be set on the Worker from an earlier push.
  const missingRequired = Object.entries(SECRETS)
    .filter(([name, spec]) => spec.required && !(name in send))
    .map(([name]) => name)
    .sort(byName)

  const errors: string[] = []
  if (unknown.length > 0) {
    errors.push(
      `Unrecognised names: ${unknown.join(', ')}. Add each to SECRETS (or NOT_SECRETS if it is a var) in scripts/secrets/plan.ts before this can run.`,
    )
  }
  if (duplicates.length > 0) {
    errors.push(`Defined more than once: ${duplicates.join(', ')}. Keep one line each; the last would silently win.`)
  }
  const pepper = values.get('OTP_PEPPER')
  if (pepper && pepper === otherEnvironment?.get('OTP_PEPPER')) {
    // Same pepper in both means a leak from staging helps against production codes. The message
    // names no value.
    errors.push("OTP_PEPPER must be different in staging and production, but both files hold the same value.")
  }

  return { send, skipped, blank, unknown, missingRequired, errors }
}

/**
 * Production is `env.production` in wrangler.jsonc, so `--env` is passed literally for both.
 * (Not a top-level environment, unlike projects where production is the unnamed one.)
 */
export function wranglerBulkArgs(environment: TargetEnvironment): string[] {
  return ['wrangler', 'secret', 'bulk', '--env', environment]
}

const USAGE = 'Usage: npm run secrets:push -- --env staging|production [--apply]'

/** Strict on purpose: a missing or misspelled flag must never fall through to pushing somewhere. */
export function parseArgs(argv: string[]): { environment: TargetEnvironment; apply: boolean } {
  let environment: string | undefined
  let apply = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    let value: string | undefined
    if (arg === '--apply') {
      apply = true
      continue
    } else if (arg === '--env') {
      value = argv[++i]
      if (value === undefined || value.startsWith('-')) throw new Error(`--env needs a value. ${USAGE}`)
    } else if (arg.startsWith('--env=')) {
      value = arg.slice('--env='.length)
    } else {
      throw new Error(`Unrecognised argument "${arg}". ${USAGE}`)
    }
    if (environment !== undefined) throw new Error(`--env given more than once. ${USAGE}`)
    environment = value
  }
  if (environment === undefined) throw new Error(`--env is required. ${USAGE}`)
  if (environment !== 'staging' && environment !== 'production') {
    throw new Error(`Unknown environment "${environment}". ${USAGE}`)
  }
  return { environment, apply }
}

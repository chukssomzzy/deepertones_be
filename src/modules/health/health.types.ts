export type CheckStatus = 'ok' | 'down'

export type HealthReport = {
  status: 'ok' | 'degraded'
  environment: string
  checks: { database: CheckStatus }
}

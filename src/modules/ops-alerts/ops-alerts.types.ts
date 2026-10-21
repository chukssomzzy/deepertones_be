/**
 * What the owner is emailed about. `ai-account` (Claude refuses our account) and `face-scan-account` (Perfect Corp does) are hourly; the rest are daily (an environment-wide
 * limit was passed). Every one is a problem for us to fix, never something a user is told about.
 */
export const OPS_ALERT_KINDS = ['ai-account', 'face-scan-account', 'ai-spend-cap', 'research-budget', 'analysis-budget'] as const
export type OpsAlertKind = (typeof OPS_ALERT_KINDS)[number]

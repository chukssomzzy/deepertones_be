/**
 * What the owner is emailed about. `ai-account` (Claude refuses our account), `face-scan-account` (Perfect Corp does) and `share-render-quota` (Cloudflare Images' free monthly
 * allowance is used up) are hourly; the rest are daily: an environment-wide limit was passed (`ai-spend-cap`, `research-budget`, `analysis-budget`), or people have sent reports to
 * read (`verdict-report`, `wrong-match-report`). Every one is a problem or a task for us, never something a user is told about.
 */
export const OPS_ALERT_KINDS = ['ai-account', 'face-scan-account', 'ai-spend-cap', 'research-budget', 'analysis-budget', 'verdict-report', 'wrong-match-report', 'share-render-quota'] as const
export type OpsAlertKind = (typeof OPS_ALERT_KINDS)[number]

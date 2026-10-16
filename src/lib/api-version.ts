/**
 * Every API route is mounted under this prefix (src/app.ts); only /health, /docs and /openapi.json stay at the root. A breaking
 * change adds `/api/v2` next to it instead of editing v1. Anything that builds a link to an API route starts from here.
 */
export const API_V1_PREFIX = '/api/v1'

import type { Actor } from '../../lib/actor'
import { signJwt, verifyJwt } from '../../lib/jwt'

export const ACCESS_TTL_SECONDS = 15 * 60
export const REFRESH_TTL_SECONDS = 60 * 24 * 60 * 60

type UserStatus = Extract<Actor, { kind: 'user' }>['status']
export type TokenFailure = 'expired' | 'invalid'

const isVersion = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0
const isProfileId = (value: unknown): value is string => typeof value === 'string' && value !== ''

export type IssuedTokens = {
  accessToken: string
  refreshToken: string
  accessExpiresAt: Date
  refreshExpiresAt: Date
}

export type AccessVerification =
  | { ok: true; userId: string; status: UserStatus; version: number; profileId: string }
  | { ok: false; problem: TokenFailure }

/** `profileId` is null for a refresh token issued before profiles, or whose claim is unusable: the caller falls back to the default. */
export type RefreshVerification =
  | { ok: true; userId: string; version: number; profileId: string | null }
  | { ok: false; problem: TokenFailure }

/**
 * Issues and verifies the access and refresh JWTs. It has no database access: it only proves a
 * token is ours, unexpired and of the right type. The refresh flow is what compares `version`
 * with the user's current token_version, and checks that the `pid` (the active profile) still belongs to the user.
 *
 * The `typ` claim keeps the two kinds apart, so a refresh token cannot be used as a bearer and
 * an access token cannot be used to refresh. `previousSecret` verifies only; new tokens are
 * always signed with `secret`.
 */
export class TokenService {
  // `#`, not `private`: they are the signing secrets, and a runtime-private field stays out of spreads and JSON.stringify.
  readonly #secret: string
  readonly #secrets: string[]
  private readonly now: () => Date

  constructor(options: { secret: string; previousSecret?: string; now?: () => Date }) {
    this.#secret = options.secret
    this.#secrets = options.previousSecret ? [options.secret, options.previousSecret] : [options.secret]
    this.now = options.now ?? (() => new Date())
  }

  async issue(user: { id: string; status: UserStatus; tokenVersion: number }, profileId: string): Promise<IssuedTokens> {
    const now = this.now()
    const base = { sub: user.id, ver: user.tokenVersion, pid: profileId }
    const [accessToken, refreshToken] = await Promise.all([
      signJwt({ ...base, st: user.status, typ: 'access' }, { secret: this.#secret, expiresInSeconds: ACCESS_TTL_SECONDS, now }),
      signJwt({ ...base, typ: 'refresh' }, { secret: this.#secret, expiresInSeconds: REFRESH_TTL_SECONDS, now }),
    ])
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: new Date(now.getTime() + ACCESS_TTL_SECONDS * 1000),
      refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_SECONDS * 1000),
    }
  }

  async verifyAccess(token: string): Promise<AccessVerification> {
    const result = await verifyJwt(token, { secrets: this.#secrets, now: this.now() })
    if (!result.ok) return { ok: false, problem: result.reason }
    const { sub, st, ver, typ, pid } = result.claims
    if (typ !== 'access' || typeof sub !== 'string' || !isVersion(ver) || (st !== 'anonymous' && st !== 'verified')) {
      return { ok: false, problem: 'invalid' }
    }
    // A token from before profiles has no pid at all: expired, so the app refreshes and gets one. Any other pid is wrong.
    if (pid === undefined) return { ok: false, problem: 'expired' }
    if (!isProfileId(pid)) return { ok: false, problem: 'invalid' }
    return { ok: true, userId: sub, status: st, version: ver, profileId: pid }
  }

  async verifyRefresh(token: string): Promise<RefreshVerification> {
    const result = await verifyJwt(token, { secrets: this.#secrets, now: this.now() })
    if (!result.ok) return { ok: false, problem: result.reason }
    const { sub, ver, typ, pid } = result.claims
    if (typ !== 'refresh' || typeof sub !== 'string' || !isVersion(ver)) return { ok: false, problem: 'invalid' }
    return { ok: true, userId: sub, version: ver, profileId: isProfileId(pid) ? pid : null }
  }
}

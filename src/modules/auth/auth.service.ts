import { hmacSha256Hex } from '../../lib/crypto'
import { requireUser } from '../../lib/context'
import { ConflictError, NotFoundError, UnauthorizedError } from '../../lib/errors'
import type { OtpChannel, OtpRecipient } from '../otp/otp.types'
import { type OtpService, parseRecipient } from '../otp/otp.service'
import type { UsersService } from '../users/users.service'
import type { Device, User, UserIdentifier } from '../users/users.types'
import type { IssuedTokens, TokenService } from './tokens.service'

export type Session = { tokens: IssuedTokens; user: User }

export type AuthServiceDeps = {
  users: UsersService
  otp: OtpService
  tokens: TokenService
  /** Keys the HMAC of device ids, so a leaked devices table cannot be matched against known device ids. */
  deviceIdKey: string
  now?: () => Date
}

const identifierOf = (recipient: OtpRecipient): UserIdentifier =>
  recipient.channel === 'email'
    ? { kind: 'email', email: recipient.address }
    : { kind: 'phone', phone: recipient.address }

/**
 * Orchestrates sign-in across the users, otp and tokens services; it owns no storage of its own.
 * Every method that acts for the caller reads the actor (requireUser), so a route cannot forget
 * the check; bootstrap and refresh are the only public entry points.
 */
export class AuthService {
  private readonly users: UsersService
  private readonly otp: OtpService
  private readonly tokens: TokenService
  // `#`, not `private`: it is the device id HMAC key, and a runtime-private field stays out of spreads and JSON.stringify.
  readonly #deviceIdKey: string

  constructor(deps: AuthServiceDeps) {
    this.users = deps.users
    this.otp = deps.otp
    this.tokens = deps.tokens
    this.#deviceIdKey = deps.deviceIdKey
  }

  /**
   * A session for the device's guest. Only an HMAC of the device id is stored, keyed per
   * environment, so the raw id never reaches the database and one id maps to different guests
   * in staging and production.
   */
  async bootstrap(deviceId: string, platform: Device['platform']): Promise<Session> {
    const deviceHash = await hmacSha256Hex(this.#deviceIdKey, deviceId)
    return this.session(await this.users.guestForDevice(deviceHash, platform))
  }

  /**
   * Needs a token (guests included), so anonymous traffic cannot make us send codes. A verified
   * caller is refused an address nobody owns before any code goes out (see rejectLinking).
   */
  async sendOtp(recipient: { channel: OtpChannel; address: string }): Promise<{ challengeId: string; expiresAt: Date }> {
    const actor = requireUser()
    await this.rejectLinking(actor.userId, recipient)
    return this.otp.send(recipient)
  }

  /**
   * Promotes the calling guest, or signs the caller in as the existing owner of the address. The
   * caller's devices are then unlinked: after a sign-in as someone else, a later logout must not
   * land the device back on the pre-login guest's data. A new session is issued. Promotion bumps
   * the token version itself; when the guest is left behind ('existing') we bump it here, so the
   * guest's old refresh token stops working in both cases.
   */
  async verifyOtp(recipient: { channel: OtpChannel; address: string }, code: string): Promise<Session> {
    const actor = requireUser()
    const caller = await this.rejectLinking(actor.userId, recipient)
    const verified = await this.otp.verify(recipient, code)
    const { outcome, user } = await this.users.promote(actor.userId, identifierOf(verified))
    if (outcome === 'existing' && caller.status === 'anonymous') await this.users.bumpTokenVersion(actor.userId)
    await this.users.unlinkDevices(actor.userId)
    return this.session(user)
  }

  /**
   * Public: the access token is usually expired by now. The refresh token must be ours, unexpired,
   * and carry the user's current token version, which is what makes logout (a bump) effective on
   * every device. A user that no longer exists is TOKEN_INVALID, not a 404: the token is what is wrong.
   */
  async refresh(refreshToken: string): Promise<Session> {
    const verified = await this.tokens.verifyRefresh(refreshToken)
    if (!verified.ok) {
      throw verified.problem === 'expired'
        ? new UnauthorizedError('TOKEN_EXPIRED', 'Your session has expired')
        : new UnauthorizedError('TOKEN_INVALID', 'Your session is not valid')
    }
    const user = await this.users.get(verified.userId).catch((error: unknown) => {
      if (error instanceof NotFoundError) return null
      throw error
    })
    if (!user || user.tokenVersion !== verified.version) {
      throw new UnauthorizedError('TOKEN_INVALID', 'Your session is not valid')
    }
    await this.users.touch(user.id)
    return this.session(user)
  }

  /**
   * Signs the user out everywhere (version bump) and hands the device a fresh guest session. The
   * user's devices are unlinked first: a guest still linked to this device would otherwise be
   * handed straight back by bootstrap, and logout would leave the same identity signed in.
   */
  async logout(deviceId: string, platform: Device['platform']): Promise<Session> {
    const actor = requireUser()
    await this.users.bumpTokenVersion(actor.userId)
    await this.users.unlinkDevices(actor.userId)
    return this.bootstrap(deviceId, platform)
  }

  async me(): Promise<User> {
    return this.users.get(requireUser().userId)
  }

  /**
   * Linking a second identifier to a verified account is not supported yet (it ships with WhatsApp).
   * Checked before a code is sent or consumed, against the caller's row rather than the token's
   * status, which can be 15 minutes stale. A verified caller may still use an address that is owned
   * (by themselves: sign in again; by another account: switch to it).
   */
  private async rejectLinking(userId: string, recipient: { channel: OtpChannel; address: string }): Promise<User> {
    const caller = await this.users.get(userId)
    if (caller.status === 'verified') {
      const owner = await this.users.findByIdentifier(identifierOf(parseRecipient(recipient.channel, recipient.address)))
      if (!owner) {
        throw new ConflictError('ACCOUNT_LINKING_UNAVAILABLE', 'Adding another email or phone to a verified account is not available yet')
      }
    }
    return caller
  }

  private async session(user: User): Promise<Session> {
    return { tokens: await this.tokens.issue(user), user }
  }
}

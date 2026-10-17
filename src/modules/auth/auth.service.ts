import { hmacSha256Hex } from '../../lib/crypto'
import { requireUser } from '../../lib/context'
import { ConflictError, NotFoundError, UnauthorizedError } from '../../lib/errors'
import type { NotificationsService } from '../notifications/notifications.service'
import type { OtpChannel, OtpRecipient } from '../otp/otp.types'
import { type OtpService, parseRecipient } from '../otp/otp.service'
import type { ProfilesService } from '../profiles/profiles.service'
import type { Profile } from '../profiles/profiles.types'
import type { UsersService } from '../users/users.service'
import type { Device, User, UserIdentifier } from '../users/users.types'
import type { IssuedTokens, TokenService } from './tokens.service'

export type Session = { tokens: IssuedTokens; user: User }

/** The signed-in user, the profile the session is on, and every profile of the user (the default first). */
export type Me = { user: User; profile: Profile; profiles: Profile[] }

export type AuthServiceDeps = {
  users: UsersService
  profiles: ProfilesService
  otp: OtpService
  tokens: TokenService
  notifications: NotificationsService
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
  private readonly profiles: ProfilesService
  private readonly otp: OtpService
  private readonly tokens: TokenService
  private readonly notifications: NotificationsService
  private readonly now: () => Date
  // `#`, not `private`: it is the device id HMAC key, and a runtime-private field stays out of spreads and JSON.stringify.
  readonly #deviceIdKey: string

  constructor(deps: AuthServiceDeps) {
    this.users = deps.users
    this.profiles = deps.profiles
    this.otp = deps.otp
    this.tokens = deps.tokens
    this.notifications = deps.notifications
    this.#deviceIdKey = deps.deviceIdKey
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * A session for the device's guest. Only an HMAC of the device id is stored, keyed per
   * environment, so the raw id never reaches the database and one id maps to different guests
   * in staging and production.
   */
  async bootstrap(deviceId: string, platform: Device['platform']): Promise<Session> {
    const deviceHash = await hmacSha256Hex(this.#deviceIdKey, deviceId)
    const user = await this.users.guestForDevice(deviceHash, platform)
    return this.session(user, (await this.profiles.defaultFor(user.id)).id)
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
   * guest's old refresh token stops working in both cases. When the guest is left behind its push tokens are deleted too,
   * last of all, once the devices are unlinked: the request carries no device id, so the guest's rows are the only way to
   * name this phone, and it registers again under the account it signed in to. A promoted guest stays on the profile it was on (same row,
   * so its scans stay readable); signing in as an existing account starts on that account's default profile.
   */
  async verifyOtp(recipient: { channel: OtpChannel; address: string }, code: string): Promise<Session> {
    const actor = requireUser()
    const caller = await this.rejectLinking(actor.userId, recipient)
    const verified = await this.otp.verify(recipient, code)
    const { outcome, user } = await this.users.promote(actor.userId, identifierOf(verified))
    const guestLeftBehind = outcome === 'existing' && caller.status === 'anonymous'
    if (guestLeftBehind) await this.users.bumpTokenVersion(actor.userId)
    await this.users.unlinkDevices(actor.userId)
    // After the unlink, so a failure here cannot skip it once the code is consumed.
    if (guestLeftBehind) {
      const platform = await this.notifications.guestSignedIn(actor.userId)
      // The account's other phones are told; the phone that signed in is not among them (its guest row is gone, and the row it registers next is newer than `at`).
      await this.notifications.newSignIn({ userId: user.id, platform, at: this.now().getTime() })
    }
    return this.session(user, outcome === 'promoted' ? actor.profileId : (await this.profiles.defaultFor(user.id)).id)
  }

  /**
   * Public: the access token is usually expired by now. The refresh token must be ours, unexpired,
   * and carry the user's current token version, which is what makes logout (a bump) effective on
   * every device. A user that no longer exists is TOKEN_INVALID, not a 404: the token is what is wrong.
   * The session stays on the token's profile while it still belongs to the user; otherwise (no pid, a deleted or
   * foreign profile) it falls back to the default, so a bad pid can never wedge a session.
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
    const kept = verified.profileId === null ? null : await this.profiles.ownedBy(user.id, verified.profileId)
    return this.session(user, (kept ?? (await this.profiles.defaultFor(user.id))).id)
  }

  /**
   * Signs the user out everywhere (version bump) and hands the device a fresh guest session. The
   * user's devices are unlinked first: a guest still linked to this device would otherwise be
   * handed straight back by bootstrap, and logout would leave the same identity signed in. Every push token of the account is
   * deleted as well: logout signs out all its phones, and each one registers again under the guest it gets next.
   */
  async logout(deviceId: string, platform: Device['platform']): Promise<Session> {
    const actor = requireUser()
    await this.users.bumpTokenVersion(actor.userId)
    await this.users.unlinkDevices(actor.userId)
    await this.notifications.accountSignedOut(actor.userId)
    return this.bootstrap(deviceId, platform)
  }

  /** A session whose profile is no longer the user's (deleted, or never theirs) is TOKEN_EXPIRED, so the app refreshes onto the default. */
  async me(): Promise<Me> {
    const { userId, profileId } = requireUser()
    const [user, profiles] = await Promise.all([this.users.get(userId), this.profiles.of(userId)])
    const profile = profiles.find((p) => p.id === profileId)
    if (!profile) throw new UnauthorizedError('TOKEN_EXPIRED', 'Your session has expired')
    return { user, profile, profiles }
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

  private async session(user: User, profileId: string): Promise<Session> {
    return { tokens: await this.tokens.issue(user, profileId), user }
  }
}

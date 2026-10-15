import { D1JobRunsRepository } from './jobs/job-runs.repository'
import { createDb } from './lib/db'
import { once } from './lib/once'
import { AuthService } from './modules/auth/auth.service'
import { TokenService } from './modules/auth/tokens.service'
import { D1HealthRepository } from './modules/health/health.repository'
import { HealthService } from './modules/health/health.service'
import { D1OtpRepository } from './modules/otp/otp.repository'
import { OtpService, parseOtpChannels } from './modules/otp/otp.service'
import { D1UsersRepository } from './modules/users/users.repository'
import { UsersService } from './modules/users/users.service'
import { ZeptoMailEmailSender } from './providers/email/zeptomail.email'
import { CloudflareQueuesJobQueue } from './providers/job-queue/cloudflare-queues.job-queue'
import { MetaWhatsAppOtpDelivery } from './providers/otp-delivery/meta-whatsapp.otp-delivery'

/**
 * The composition root: the ONLY file that knows concrete repository, provider and
 * service classes. Built per request (bindings arrive with the request) and lazy, so a
 * request only constructs what it touches.
 *
 * To add a module: build its repository from db(), its providers from env, and pass
 * other modules' services (never their repositories) by calling their `once` factory.
 *   const tracks = once(() => new TracksService(new D1TracksRepository(db()), users()))
 * then expose it as a getter below.
 */
export const buildContainer = (env: CloudflareBindings) => {
  const db = once(() => createDb(env.DB))

  const health = once(() => new HealthService(new D1HealthRepository(db()), env.ENVIRONMENT))

  // Shared: later modules send email too.
  const email = once(
    () =>
      new ZeptoMailEmailSender({
        apiUrl: env.ZEPTOMAIL_API_URL,
        apiKey: env.ZEPTOMAIL_API_KEY,
        fromAddress: env.EMAIL_FROM_ADDRESS,
        fromName: env.EMAIL_FROM_NAME,
      }),
  )

  const otp = once(
    () =>
      new OtpService({
        repository: new D1OtpRepository(db()),
        jobs: new CloudflareQueuesJobQueue({ 'otp-delivery': env.OTP_DELIVERY_QUEUE }),
        channels: parseOtpChannels(env.OTP_CHANNELS),
        email: email(),
        whatsapp: new MetaWhatsAppOtpDelivery({
          accessToken: env.WHATSAPP_ACCESS_TOKEN ?? '',
          phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
          templateName: env.WHATSAPP_OTP_TEMPLATE,
          languageCode: env.WHATSAPP_OTP_LANGUAGE,
        }),
        pepper: env.OTP_PEPPER,
      }),
  )

  const users = once(() => new UsersService({ repository: new D1UsersRepository(db()) }))

  const tokens = once(() => new TokenService({ secret: env.JWT_SECRET, previousSecret: env.JWT_SECRET_PREVIOUS || undefined }))

  const auth = once(
    () => new AuthService({ users: users(), otp: otp(), tokens: tokens(), deviceIdKey: env.DEVICE_ID_KEY }),
  )

  return {
    get auth() {
      return auth()
    },
    get health() {
      return health()
    },
    get otp() {
      return otp()
    },
    get tokens() {
      return tokens()
    },
    get users() {
      return users()
    },
  }
}

export type Container = ReturnType<typeof buildContainer>

/**
 * What a queue consumer needs: the services (what routes get) plus the job-run bookkeeping.
 * jobRuns stays out of the services Container so routes can never reach a repository.
 */
export const buildJobRuntime = (env: CloudflareBindings) => ({
  services: buildContainer(env),
  jobRuns: new D1JobRunsRepository(createDb(env.DB)),
})

import { defineRoute, errorResponses, ok, openapiApp, success, jsonBody } from '../../lib/openapi'
import { rateLimit } from '../../middleware/rate-limit'
import { toOtpChallengeResponse, toSessionResponse, toUserResponse } from './auth.presenter'
import { DeviceBody, OtpChallengeResponse, RefreshBody, SendOtpBody, SessionResponse, UserResponse, VerifyOtpBody } from './auth.schemas'

const bearer = [{ bearerAuth: [] }]

const bootstrap = defineRoute({
  method: 'post',
  path: '/anonymous',
  operationId: 'bootstrapGuest',
  tags: ['Auth'],
  summary: 'Start a guest session for this device',
  description: 'Call at app start. The same device id always gets the same guest, until that guest verifies an account.',
  security: [],
  middleware: [rateLimit('AUTH_BOOTSTRAP_IP_LIMITER', 'ip')],
  request: { body: jsonBody(DeviceBody) },
  responses: { 200: success(SessionResponse, 'The guest and its tokens'), ...errorResponses(429) },
})

const sendOtp = defineRoute({
  method: 'post',
  path: '/otp/send',
  operationId: 'sendOtp',
  tags: ['Auth'],
  summary: 'Email or WhatsApp a sign-in code',
  description: 'Needs the guest session\'s access token. A code is sent at most once a minute per address.',
  security: bearer,
  middleware: [rateLimit('AUTH_OTP_SEND_IP_LIMITER', 'ip'), rateLimit('AUTH_OTP_SEND_USER_LIMITER', 'user')],
  request: { body: jsonBody(SendOtpBody) },
  responses: { 200: success(OtpChallengeResponse, 'The code is on its way'), ...errorResponses(401, 404, 409, 429) },
})

const verifyOtp = defineRoute({
  method: 'post',
  path: '/otp/verify',
  operationId: 'verifyOtp',
  tags: ['Auth'],
  summary: 'Check a code and sign in',
  description:
    'Verifies the calling guest with the address, or signs them in as the address\'s existing owner. ' +
    'Replaces every earlier token: store the new pair.',
  security: bearer,
  middleware: [rateLimit('AUTH_OTP_VERIFY_IP_LIMITER', 'ip')],
  request: { body: jsonBody(VerifyOtpBody) },
  responses: { 200: success(SessionResponse, 'The verified user and new tokens'), ...errorResponses(401, 404, 409, 429) },
})

const refresh = defineRoute({
  method: 'post',
  path: '/refresh',
  operationId: 'refreshSession',
  tags: ['Auth'],
  summary: 'Trade a refresh token for a new token pair',
  description: 'Ignores the Authorization header, so an expired access token does not matter.',
  security: [],
  middleware: [rateLimit('AUTH_REFRESH_IP_LIMITER', 'ip')],
  request: { body: jsonBody(RefreshBody) },
  responses: { 200: success(SessionResponse, 'The same user, new tokens'), ...errorResponses(401, 429) },
})

const logout = defineRoute({
  method: 'post',
  path: '/logout',
  operationId: 'logout',
  tags: ['Auth'],
  summary: 'Sign out everywhere and start a fresh guest session',
  description: 'Every refresh token the user holds stops working. The response is a new guest for this device.',
  security: bearer,
  middleware: [rateLimit('AUTH_BOOTSTRAP_IP_LIMITER', 'ip')],
  request: { body: jsonBody(DeviceBody) },
  responses: { 200: success(SessionResponse, 'A new guest and its tokens'), ...errorResponses(401, 404, 429) },
})

const getMe = defineRoute({
  method: 'get',
  path: '/',
  operationId: 'getMe',
  tags: ['Auth'],
  summary: 'The signed-in user',
  security: bearer,
  responses: { 200: success(UserResponse, 'The user'), ...errorResponses(401, 404) },
})

export const authRoutes = openapiApp()
  .openapi(bootstrap, async (c) => {
    const { deviceId, platform } = c.req.valid('json')
    return ok(c, toSessionResponse(await c.var.services.auth.bootstrap(deviceId, platform)), 'Guest session started')
  })
  .openapi(sendOtp, async (c) => {
    const challenge = await c.var.services.auth.sendOtp(c.req.valid('json'))
    return ok(c, toOtpChallengeResponse(challenge), 'Code sent')
  })
  .openapi(verifyOtp, async (c) => {
    const { code, ...recipient } = c.req.valid('json')
    return ok(c, toSessionResponse(await c.var.services.auth.verifyOtp(recipient, code)), 'Signed in')
  })
  .openapi(refresh, async (c) => {
    const { refreshToken } = c.req.valid('json')
    return ok(c, toSessionResponse(await c.var.services.auth.refresh(refreshToken)), 'Session refreshed')
  })
  .openapi(logout, async (c) => {
    const { deviceId, platform } = c.req.valid('json')
    return ok(c, toSessionResponse(await c.var.services.auth.logout(deviceId, platform)), 'Signed out')
  })

export const meRoutes = openapiApp().openapi(getMe, async (c) =>
  ok(c, toUserResponse(await c.var.services.auth.me()), 'User found'),
)

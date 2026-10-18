import { defineRoute, ok, openapiApp, success } from '../../lib/openapi'
import { contentFor } from './onboarding.content'
import { toOnboardingContentResponse } from './onboarding.presenter'
import { OnboardingContentQuery, OnboardingContentResponse } from './onboarding.schemas'

// Five minutes keeps a copy deploy reaching the apps quickly; stale-while-revalidate lets an app or the edge show the old text for up to a day
// while it asks again (a 304 when nothing changed), so opening the app never waits on this call. The content is the same for everyone, so it is public.
const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=86400'

/** Whether an If-None-Match header (a list of ETags, weak ones allowed, or `*`) names this one. */
const matches = (header: string | undefined, etag: string) =>
  header !== undefined && header.split(',').some((candidate) => candidate.trim() === '*' || candidate.trim().replace(/^W\//, '') === etag)

const cacheHeaders = {
  ETag: { description: 'The content version, in quotes.', schema: { type: 'string' as const } },
  'Cache-Control': { description: `\`${CACHE_CONTROL}\``, schema: { type: 'string' as const } },
}

const getOnboardingContent = defineRoute({
  method: 'get',
  path: '/content',
  operationId: 'getOnboardingContent',
  tags: ['Onboarding'],
  summary: 'The text of the first-run screens',
  description:
    'Everything the app shows on the goal, answer and safety screens (1.2 to 1.5): the questions, labels and button text, the goal chips and safety choices with their ids, and the answer card for each goal. ' +
    'The app fetches this first and renders from it, so a copy change, a new chip or a new choice needs a deploy and not an app release. ' +
    'No token is needed, and one that is sent is ignored; the content is the same for everyone. ' +
    '`locale` falls back to `en` for anything else and is never an error. `contentVersion` is a hash of the content and is also the `ETag`: send it back in `If-None-Match` to get an empty 304 while nothing changed. ' +
    'Sent with `Cache-Control: public, max-age=300, stale-while-revalidate=86400`.',
  security: [],
  request: { query: OnboardingContentQuery },
  responses: {
    200: { ...success(OnboardingContentResponse, 'The text of the first-run screens'), headers: cacheHeaders },
    304: { description: 'The `If-None-Match` ETag is the current one; no body', headers: cacheHeaders },
  },
})

export const onboardingRoutes = openapiApp().openapi(getOnboardingContent, async (c) => {
  const content = await contentFor(c.req.valid('query').locale ?? 'en')
  const etag = `"${content.contentVersion}"`
  c.header('ETag', etag)
  c.header('Cache-Control', CACHE_CONTROL)
  if (matches(c.req.header('If-None-Match'), etag)) return c.body(null, 304)
  return ok(c, toOnboardingContentResponse(content), 'Onboarding content')
})

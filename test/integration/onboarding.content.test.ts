import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { describe, expect, it } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { answerFor } from '../../src/modules/goals/goals.answers'
import { GOALS, type Goal } from '../../src/modules/goals/goals.vocabulary'

// GET /api/v1/onboarding/content through the Worker's public surface: the text of onboarding screens 1.2 to 1.5, served by the backend so a
// copy change, a new chip or a new choice is a deploy and not an app release (issue #82, the PR 5 addendum). The content call itself is a
// plain fetch, because the tests need to send If-None-Match and to read the headers; the typed client is used only to make a guest and to
// PUT the goal and the safety answers, which is how a chip or a choice proves it is a value the API accepts.
//
// The strings below are the mock text of the screens, word for word, and are written out on purpose: the brief is where they come from,
// not the code under test. The two DRAFT ones (the sixth chip, the field under the reaction choice) need owner review before launch.

// Safety PUTs may hand words to the parse job; none of these tests send words, but a real queue must never be reachable from here.
const noQueue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue
const WORKER_ENV = { ...env, PARSE_SAFETY_QUEUE: noQueue }

const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) =>
  worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())

const api = hc<AppType>('http://deepertones.test', { fetch: fetchWorker as typeof fetch })
// Every API route lives under /api/v1.
const v1 = api.api.v1

const CONTENT_PATH = '/api/v1/onboarding/content'
const contentUrl = (query = '') => `http://deepertones.test${CONTENT_PATH}${query}`

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
// A new IP per call keeps the rate limits (keyed by IP) from coupling tests to each other.
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}

type Envelope<T> = { success: true; status: number; message: string; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number }
type Chip = { id: string; label: string }
type Field = { label: string; hint?: string }
type Choice = { id: string; label: string; field?: Field }
type Answer = { title: string; howLong: string; helps: string; inTheWay: string }
type Content = {
  locale: string
  contentVersion: string
  goalScreen: {
    title: string
    subtitle: string
    placeholder: string
    footnote: string
    continueLabel: string
    loginLabel: string
    chips: Chip[]
  }
  answerScreen: { subtitle: string; howLongLabel: string; helpsLabel: string; inTheWayLabel: string; continueLabel: string; changeLabel: string }
  answers: Record<string, Answer>
  colourNote: string
  safetyScreen: { title: string; subtitle: string; footnote: string; continueLabel: string; choices: Choice[] }
}

const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = (await res.json()) as Envelope<T>
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}

const getContent = (init: { query?: string; headers?: Record<string, string> } = {}) =>
  fetchWorker(contentUrl(init.query), { headers: { 'cf-connecting-ip': freshIp(), ...init.headers } })
const contentOf = async (init?: { query?: string; headers?: Record<string, string> }) => dataOf<Content>(await getContent(init))

const headers = (bearer?: string): Record<string, string> => ({
  'cf-connecting-ip': freshIp(),
  ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
})

/** A new guest session, the way an app install starts one. */
const newGuestToken = async () => {
  const deviceId = `device-install-${runSalt}-${next()}`
  const res = await v1.auth.anonymous.$post({ json: { deviceId, platform: 'ios' } }, { headers: headers() })
  expect(res.status).toBe(200)
  const session = await dataOf<{ tokens: { accessToken: string } }>(res)
  return session.tokens.accessToken
}

describe('GET /api/v1/onboarding/content is public', () => {
  it('answers 200 with the usual success envelope to Amara, who has no account and no token', async () => {
    const res = await getContent()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toMatchObject({ success: true, status: 200, message: expect.any(String), data: { locale: 'en' } })
  })

  it('gives a guest with a token the same content, since it is the same for everyone', async () => {
    const token = await newGuestToken()

    const withToken = await contentOf({ headers: { Authorization: `Bearer ${token}` } })

    expect(withToken).toEqual(await contentOf())
  })

  it('ignores a token it cannot read instead of refusing the request', async () => {
    const res = await getContent({ headers: { Authorization: 'Bearer not-a-real-token' } })

    expect(res.status).toBe(200)
    expect(await dataOf<Content>(res)).toEqual(await contentOf())
  })
})

describe('the content of GET /api/v1/onboarding/content', () => {
  it('has exactly the documented top-level keys, with a version that is a non-empty string', async () => {
    const data = await contentOf()

    expect(Object.keys(data).sort()).toEqual(['answerScreen', 'answers', 'colourNote', 'contentVersion', 'goalScreen', 'locale', 'safetyScreen'])
    expect(data.contentVersion).toMatch(/^[A-Za-z0-9+/=_-]+$/)
  })

  it('says the goal screen word for word, with the six chips in display order and calm-repair last', async () => {
    const { goalScreen } = await contentOf()

    expect(goalScreen).toEqual({
      title: 'What do you want your skin to look like?',
      subtitle: "Say it your way. We'll tell you honestly what it takes.",
      placeholder: 'For example: clear skin',
      footnote: 'No account needed.',
      continueLabel: 'Continue',
      loginLabel: 'Login',
      chips: [
        { id: 'clear-skin', label: 'Clear skin' },
        { id: 'even-tone', label: 'Even tone' },
        { id: 'fade-dark-marks', label: 'Fade dark marks' },
        { id: 'brighter', label: 'Brighter, more even' },
        { id: 'glow', label: 'A glow' },
        { id: 'calm-repair', label: 'Calm, healthy skin' },
      ],
    })
  })

  it('says the answer screen word for word', async () => {
    const { answerScreen } = await contentOf()

    expect(answerScreen).toEqual({
      subtitle: 'Here is what it usually takes.',
      howLongLabel: 'How long it takes',
      helpsLabel: 'What helps',
      inTheWayLabel: 'What gets in the way',
      continueLabel: 'Continue',
      changeLabel: 'Change my goal',
    })
  })

  it('says the safety screen word for word, with a text field under only the reaction and prescription choices', async () => {
    const { safetyScreen } = await contentOf()

    expect(safetyScreen).toEqual({
      title: "Anything that changes what's safe for you?",
      subtitle: "Some ingredients aren't safe in certain situations. Tell us, and we'll leave them out of everything.",
      footnote: 'You can change this any time in Settings.',
      continueLabel: 'Continue',
      choices: [
        { id: 'pregnant', label: 'Pregnant' },
        { id: 'breastfeeding', label: 'Breastfeeding' },
        {
          id: 'reaction',
          label: 'A product gave me a reaction',
          field: { label: 'Which product? (optional)', hint: 'Add the ingredient too if you know it.' },
        },
        {
          id: 'prescription',
          label: 'Using a prescription cream or tablets',
          field: { label: 'What is it? (optional)', hint: 'Product names help us check.' },
        },
        { id: 'none', label: 'None of these' },
      ],
    })
  })

  it('gives no field at all to pregnant, breastfeeding and none, so the app shows no text box there', async () => {
    const { choices } = (await contentOf()).safetyScreen

    for (const choice of choices.filter(({ id }) => ['pregnant', 'breastfeeding', 'none'].includes(id))) {
      expect(choice, choice.id).not.toHaveProperty('field')
    }
  })

  it('has one answer card for each goal and nothing else, each the honest answer without the colour note', async () => {
    const { answers } = await contentOf()

    expect(Object.keys(answers)).toEqual([...GOALS])
    for (const goal of GOALS as readonly Goal[]) {
      const { note: _note, ...plan } = answerFor(goal, false)
      expect(answers[goal], goal).toEqual(plan)
    }
  })

  it('carries the colour note the goal answers use when Tolu asks to be lighter, so the words have one source', async () => {
    const { colourNote } = await contentOf()

    expect(colourNote).toBe(answerFor('brighter', true).note)
    expect(colourNote.trim()).not.toBe('')
  })

  it('keeps the sixth chip label apart from the calm-repair answer title, which says "again"', async () => {
    const data = await contentOf()

    expect(data.goalScreen.chips[5]?.label).toBe('Calm, healthy skin')
    expect(data.answers['calm-repair']?.title).toBe('Calm, healthy skin again')
  })
})

// A chip or a choice the app shows that the API then refuses would strand the user on the very first run, so each is tried for real. The
// ids come from the response, which is what the app reads, and a fresh guest is used each time to stay clear of the per-user rate limit.
describe('every chip and choice in the content is a value the API accepts', () => {
  const chips = async () => (await contentOf()).goalScreen.chips

  it('is accepted by PUT /api/v1/me/goal for each of the six chips', async () => {
    const ids = (await chips()).map((chip) => chip.id)
    expect(ids).toHaveLength(6)

    for (const id of ids) {
      const token = await newGuestToken()

      const res = await v1.me.goal.$put({ json: { goal: id } as never }, { headers: headers(token) })

      expect(res.status, `chip ${id}`).toBe(200)
      expect((await dataOf<{ goal: string }>(res)).goal).toBe(id)
    }
  })

  it('is accepted by PUT /api/v1/me/safety for each choice alone, none included', async () => {
    const ids = (await contentOf()).safetyScreen.choices.map((choice) => choice.id)
    expect(ids).toHaveLength(5)

    for (const id of ids) {
      const token = await newGuestToken()

      const res = await v1.me.safety.$put({ json: { choices: [id] } as never }, { headers: headers(token) })

      expect(res.status, `choice ${id}`).toBe(200)
      expect((await dataOf<{ choices: string[] }>(res)).choices).toEqual([id])
    }
  })
})

describe('caching of GET /api/v1/onboarding/content', () => {
  it('sends the content version as a quoted ETag, so the app and the edge can ask whether it changed', async () => {
    const res = await getContent()

    const data = await dataOf<Content>(res)
    expect(res.headers.get('etag')).toBe(`"${data.contentVersion}"`)
  })

  it('has the same content version, and so the same ETag, on every call and for every caller', async () => {
    const token = await newGuestToken()

    const first = await getContent()
    const second = await getContent({ headers: { Authorization: `Bearer ${token}` } })

    expect(second.headers.get('etag')).toBe(first.headers.get('etag'))
    expect((await dataOf<Content>(second)).contentVersion).toBe((await dataOf<Content>(first)).contentVersion)
  })

  it('lets anyone cache it: Cache-Control is public with a max-age', async () => {
    const res = await getContent()

    const cacheControl = res.headers.get('cache-control')
    expect(cacheControl).toMatch(/\bpublic\b/)
    expect(cacheControl).toMatch(/\bmax-age=\d+\b/)
  })

  it('answers 304 with no body when If-None-Match is the current ETag', async () => {
    const etag = (await getContent()).headers.get('etag')
    expect(etag).not.toBeNull()

    const res = await getContent({ headers: { 'If-None-Match': etag! } })

    expect(res.status).toBe(304)
    expect(await res.text()).toBe('')
    expect(res.headers.get('etag')).toBe(etag)
    expect(res.headers.get('cache-control')).toMatch(/\bpublic\b/)
  })

  it('answers 304 to a signed-in guest too, since a token changes nothing', async () => {
    const etag = (await getContent()).headers.get('etag')!
    const token = await newGuestToken()

    const res = await getContent({ headers: { 'If-None-Match': etag, Authorization: `Bearer ${token}` } })

    expect(res.status).toBe(304)
  })

  it('answers 200 with the whole content when If-None-Match is an ETag from an older version', async () => {
    const res = await getContent({ headers: { 'If-None-Match': '"an-older-version"' } })

    expect(res.status).toBe(200)
    expect((await dataOf<Content>(res)).locale).toBe('en')
  })

  // What a browser, an app's HTTP cache or the edge sends back is not always the bare tag: a weak copy of it (a proxy may weaken an ETag), a
  // list of tags it holds, or `*`. All of them mean "I have the current version".
  it.each([
    ['the weak form of the ETag', (etag: string) => `W/${etag}`],
    ['a list that holds the ETag after another tag', (etag: string) => `"zzz", ${etag}`],
    ['a weak list that holds the ETag', (etag: string) => `W/"zzz",W/${etag}`],
    ['*', () => '*'],
  ])('answers 304 with no body when If-None-Match is %s', async (_name, validatorFor) => {
    const etag = (await getContent()).headers.get('etag')
    expect(etag).toMatch(/^"[^"]+"$/)

    const res = await getContent({ headers: { 'If-None-Match': validatorFor(etag!) } })

    expect(res.status).toBe(304)
    expect(await res.text()).toBe('')
  })

  it('answers 200 with the whole content when If-None-Match is a list that does not hold the current ETag', async () => {
    const res = await getContent({ headers: { 'If-None-Match': '"zzz", W/"yyy"' } })

    expect(res.status).toBe(200)
    expect((await dataOf<Content>(res)).locale).toBe('en')
  })
})

describe('the locale of GET /api/v1/onboarding/content', () => {
  it('is en when none is asked for', async () => {
    expect((await contentOf()).locale).toBe('en')
  })

  it('is en when en is asked for', async () => {
    expect((await contentOf({ query: '?locale=en' })).locale).toBe('en')
  })

  it('falls back to en for a locale that does not ship yet, and says so in the response', async () => {
    const data = await contentOf({ query: '?locale=yo' })

    expect(data.locale).toBe('en')
    expect(data).toEqual(await contentOf())
  })

  it('gives the fallback the same ETag as en, since it is the same content', async () => {
    const fallback = await getContent({ query: '?locale=yo' })
    const english = await getContent()

    expect(english.headers.get('etag')).toMatch(/^"[^"]+"$/)
    expect(fallback.headers.get('etag')).toBe(english.headers.get('etag'))
  })

  it.each(['?locale=fr&locale=en', '?locale=en&locale=fr'])('is en with a 200 when the locale is given twice, as %s', async (query) => {
    const res = await getContent({ query })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, status: 200, data: { locale: 'en' } })
  })

  it('falls back to en for an empty locale', async () => {
    const res = await getContent({ query: '?locale=' })

    expect(res.status).toBe(200)
    expect((await dataOf<Content>(res)).locale).toBe('en')
  })

  it.each([
    ['35 characters', 'x'.repeat(35)],
    ['36 characters, one over', 'x'.repeat(36)],
    ['500 characters', 'x'.repeat(500)],
    ['a path', '../etc/passwd'],
    ['a path in a locale shape', 'en/../..'],
    ['markup', '<script>alert(1)</script>'],
    ['spaces and a quote', "en US'"],
  ])('falls back to en with a 200, not an error, for a locale of %s', async (_name, locale) => {
    const res = await getContent({ query: `?locale=${encodeURIComponent(locale)}` })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, status: 200, data: { locale: 'en' } })
  })
})

describe('the OpenAPI document', () => {
  type Operation = { operationId?: string; summary?: string; tags?: string[]; security?: unknown[]; parameters?: { name: string; in: string }[] }

  it('documents GET /api/v1/onboarding/content as a public Onboarding operation that takes a locale query', async () => {
    const res = await fetchWorker('http://deepertones.test/openapi.json')
    expect(res.status).toBe(200)
    const { paths } = (await res.json()) as { paths: Record<string, Record<string, Operation>> }

    const operation = paths[CONTENT_PATH]?.get

    expect(operation?.operationId).toBe('getOnboardingContent')
    expect(operation?.tags).toEqual(['Onboarding'])
    expect(operation?.summary).toEqual(expect.any(String))
    expect(operation?.security).toEqual([])
    expect(operation?.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'locale', in: 'query' })]))
  })
})

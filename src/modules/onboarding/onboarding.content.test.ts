import { describe, expect, it } from 'vitest'
import { answerFor } from '../goals/goals.answers'
import { GOALS, type Goal } from '../goals/goals.vocabulary'
import { SAFETY_CHOICES } from '../safety/safety.vocabulary'
import { CONTENT_SHAPE_VERSION, contentFor, contentVersionOf, DRAFT_COPY } from './onboarding.content'

// The copy of onboarding screens 1.2 to 1.5, as a pure value. The exact strings are pinned through the route (onboarding.content.test.ts in
// test/integration); these tests pin what the module itself promises: its ids are the API's own vocabularies, its answers have one source, and
// its version moves whenever any word moves. `await` is on every call because a hash may be computed with crypto.subtle, which is async.

describe('contentFor', () => {
  it('lists the chips as exactly the goals, in the order the app shows them', async () => {
    const { goalScreen } = await contentFor('en')

    expect(goalScreen.chips.map((chip) => chip.id)).toEqual([...GOALS])
    expect(goalScreen.chips.at(-1)?.id).toBe('calm-repair')
  })

  it('gives every chip a label, so no tile is blank', async () => {
    for (const chip of (await contentFor('en')).goalScreen.chips) expect(chip.label.trim(), chip.id).not.toBe('')
  })

  it('lists the choices as exactly the safety choices, in the order the app shows them', async () => {
    const { safetyScreen } = await contentFor('en')

    expect(safetyScreen.choices.map((choice) => choice.id)).toEqual([...SAFETY_CHOICES])
  })

  it('puts a text field under reaction and prescription only', async () => {
    const { choices } = (await contentFor('en')).safetyScreen

    expect(choices.filter((choice) => 'field' in choice).map((choice) => choice.id)).toEqual(['reaction', 'prescription'])
  })

  it('gives each goal the answer goals.answers has for it, without the colour note', async () => {
    const { answers } = await contentFor('en')

    expect(Object.keys(answers)).toEqual([...GOALS])
    for (const goal of GOALS as readonly Goal[]) {
      const { note: _note, ...plan } = answerFor(goal, false)
      expect(answers[goal], goal).toStrictEqual(plan)
    }
  })

  it('takes the colour note from goals.answers, whichever goal it asks', async () => {
    const { colourNote } = await contentFor('en')

    for (const goal of GOALS as readonly Goal[]) expect(colourNote, goal).toBe(answerFor(goal, true).note)
  })

  // The heads-up before a goal switch (issue #145): the app shows one of these two lines next to what `GET /me/goal/switch-preview` answers, so
  // they are keyed by its `outcome` and the app can read `switchScreen[outcome]`. Both are DRAFT; the words themselves are the owner's to settle.
  it('gives the switch heads-up a line for each outcome, so neither a resume nor a fresh start is left blank', async () => {
    const { switchScreen } = await contentFor('en')

    expect(Object.keys(switchScreen).sort()).toEqual(['fresh', 'resume'])
    expect(switchScreen.resume.trim()).not.toBe('')
    expect(switchScreen.fresh.trim()).not.toBe('')
    expect(switchScreen.resume).not.toBe(switchScreen.fresh)
  })

  it('says en for en', async () => {
    expect((await contentFor('en')).locale).toBe('en')
  })

  it.each(['yo', 'ig', 'fr', '', '../etc/passwd', 'x'.repeat(36), 'EN-ZZ'])('falls back to en for the locale "%s", with the same content', async (locale) => {
    const content = await contentFor(locale)

    expect(content.locale).toBe('en')
    expect(content).toStrictEqual(await contentFor('en'))
  })

  it('gives the same content, and the same version, on every call', async () => {
    const first = await contentFor('en')
    const second = await contentFor('en')

    expect(second).toStrictEqual(first)
    expect(second.contentVersion).toBe(first.contentVersion)
  })

  it('carries as its contentVersion the version of the rest of its content', async () => {
    const { contentVersion, ...rest } = await contentFor('en')

    expect(await contentVersionOf(rest)).toBe(contentVersion)
  })
})

describe('contentVersionOf', () => {
  const baseOf = async () => {
    const { contentVersion: _version, ...rest } = await contentFor('en')
    return rest
  }

  /** Every path to a string inside the content, as a list of keys, so a test can change one string at a time. */
  const stringPaths = (value: unknown, path: (string | number)[] = []): (string | number)[][] => {
    if (typeof value === 'string') return [path]
    if (Array.isArray(value)) return value.flatMap((item, index) => stringPaths(item, [...path, index]))
    if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => stringPaths(item, [...path, key]))
    return []
  }

  const withStringChanged = (content: object, path: (string | number)[]) => {
    const copy = structuredClone(content) as Record<string | number, unknown>
    let holder = copy
    for (const key of path.slice(0, -1)) holder = holder[key] as Record<string | number, unknown>
    const last = path.at(-1)!
    holder[last] = `${holder[last] as string}x`
    return copy
  }

  it('is a non-empty string that is safe inside the quotes of an ETag', async () => {
    const version = await contentVersionOf(await baseOf())

    expect(version).toMatch(/^[A-Za-z0-9+/=_-]+$/)
  })

  it('is the same for the same content, however many times it is asked', async () => {
    expect(await contentVersionOf(await baseOf())).toBe(await contentVersionOf(await baseOf()))
  })

  it('changes when any one string in the content changes', async () => {
    const base = await baseOf()
    const original = await contentVersionOf(base)
    const paths = stringPaths(base)
    // Every label, every id, every answer and note: far more than a few screens' worth of strings, so a hash of only some of them is caught.
    expect(paths.length).toBeGreaterThan(60)

    for (const path of paths) {
      const changed = await contentVersionOf(withStringChanged(base, path) as typeof base)
      expect(changed, path.join('.')).not.toBe(original)
    }
  })

  it('changes when two chips swap places, since the display order is part of the content', async () => {
    const base = await baseOf()
    const swapped = structuredClone(base)
    const [first, second] = swapped.goalScreen.chips
    swapped.goalScreen.chips[0] = second!
    swapped.goalScreen.chips[1] = first!

    expect(await contentVersionOf(swapped)).not.toBe(await contentVersionOf(base))
  })

  it('changes when a choice is added, so a new choice is a new version', async () => {
    const base = await baseOf()
    const grown = structuredClone(base)
    grown.safetyScreen.choices.push({ id: 'new-choice', label: 'Something else' } as never)

    expect(await contentVersionOf(grown)).not.toBe(await contentVersionOf(base))
  })

  /** The same value with the keys of every object written in the opposite order. */
  const reversed = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reversed)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)]))
    return value
  }

  // The heads-up words are copy like any other, so a change to either of them must reach the apps: they are part of what is hashed, which the
  // "changes when any one string changes" test above only covers while they are strings in the content.
  it('counts the switch heads-up lines among the strings it hashes', async () => {
    const base = await baseOf()

    expect(stringPaths(base)).toEqual(expect.arrayContaining([['switchScreen', 'resume'], ['switchScreen', 'fresh']]))
  })

  it('does not depend on the order the keys of the content are written in', async () => {
    const base = await baseOf()
    const flipped = reversed(base) as typeof base
    expect(Object.keys(flipped)).toEqual(Object.keys(base).reverse())

    expect(await contentVersionOf(flipped)).toBe(await contentVersionOf(base))
  })

  it('treats a key set to undefined as a key that is not there, since JSON leaves it out', async () => {
    expect(await contentVersionOf({ a: 1, b: undefined } as never)).toBe(await contentVersionOf({ a: 1 } as never))
  })

  it('is a positive whole number, CONTENT_SHAPE_VERSION, that the owner bumps when the shape of the response changes', () => {
    expect(Number.isInteger(CONTENT_SHAPE_VERSION)).toBe(true)
    expect(CONTENT_SHAPE_VERSION).toBeGreaterThan(0)
  })

  it('hashes the shape version in, so a new shape is a new version even when every word is the same', async () => {
    const base = await baseOf()

    expect(await contentVersionOf(base, CONTENT_SHAPE_VERSION + 1)).not.toBe(await contentVersionOf(base, CONTENT_SHAPE_VERSION))
  })

  it('uses CONTENT_SHAPE_VERSION when no shape version is given', async () => {
    const base = await baseOf()

    expect(await contentVersionOf(base)).toBe(await contentVersionOf(base, CONTENT_SHAPE_VERSION))
  })
})

// The sixth chip and the field under the reaction choice are new words nobody has reviewed yet (issue #82), and so are the two lines of the goal-switch
// heads-up (issue #145). DRAFT_COPY lists the copy still in draft, so the owner finds it before launch and a later reader does not mistake it for
// approved copy. Removing a string from it is the act of approving that string.
describe('DRAFT_COPY', () => {
  it('lists exactly the strings still in draft, the goal-switch heads-up included', async () => {
    const { switchScreen } = await contentFor('en')

    expect([...DRAFT_COPY].sort()).toEqual(
      ['Add the ingredient too if you know it.', 'Calm, healthy skin', 'Which product? (optional)', switchScreen.resume, switchScreen.fresh].sort(),
    )
  })

  it('lists only words the content actually shows, so the list cannot name copy that has gone', async () => {
    const content = JSON.stringify(await contentFor('en'))

    for (const text of DRAFT_COPY) expect(content, text).toContain(JSON.stringify(text))
  })
})

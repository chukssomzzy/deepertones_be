import { describe, expect, it } from 'vitest'
import { buildContainer } from '../../src/container'
import { WORKER_ENV, applied, baseGuideRows, exportLive, guideRow } from './admin.catalog.support'

// CatalogWorkbookService.guideFor(step, goal) against real local D1, wired as the Worker wires it: the guide a person is shown for a routine step. The rows
// get there the way the team's do, through the admin import (export, edit, upload), and are read back through the service. What the import accepts, and the
// diff it reports, is in admin.catalog.import.test.ts; the unit tier has the same behaviour over the fake repository (catalog.workbook.service.test.ts).
// The database is shared by the whole file and a guide is its step and goal, so a test writes the rows it reads. The first test runs before any is written.

const workbook = () => buildContainer(WORKER_ENV).catalogWorkbook

/** The workbook's Guides tab is exactly these rows: the base row of each step (each says its step) and what the test adds. */
const setGuides = (...extra: ReturnType<typeof guideRow>[]) => applied((w) => (w.guides.rows = [...baseGuideRows(), ...extra]))

const goalGuide = (over: Parameters<typeof guideRow>[0] = {}) =>
  guideRow({ step: 'treat', goal: 'fade-dark-marks', what_it_does: 'Helps dark marks fade.', look_for: 'Niacinamide or azelaic acid.', for_deeper_skin: 'Go slowly.', look_for_when_pregnant: 'Azelaic acid only.', ...over })

describe('guideFor on a database where nobody has written a guide', () => {
  it('gives null for every step and goal: there is nothing approved to give', async () => {
    for (const step of ['cleanse', 'treat', 'moisturise', 'protect'] as const) expect(await workbook().guideFor(step, 'glow'), step).toBeNull()
  })
})

describe('guideFor after the team has written guides', () => {
  it('gives the step and goal guide when there is an approved one, as exactly the four texts', async () => {
    await setGuides(goalGuide())

    expect(await workbook().guideFor('treat', 'fade-dark-marks')).toEqual({
      whatItDoes: 'Helps dark marks fade.',
      lookFor: 'Niacinamide or azelaic acid.',
      forDeeperSkin: 'Go slowly.',
      lookForWhenPregnant: 'Azelaic acid only.',
    })
  })

  it('falls back to the step\'s base guide for a goal with no guide of its own, and for the same goal on another step', async () => {
    await setGuides(goalGuide())

    expect(await workbook().guideFor('treat', 'glow')).toEqual({ whatItDoes: 'What treat does.', lookFor: 'What to look for in treat.', forDeeperSkin: 'Deeper skin and treat.', lookForWhenPregnant: null })
    expect(await workbook().guideFor('protect', 'fade-dark-marks')).toMatchObject({ whatItDoes: 'What protect does.' })
  })

  it('gives a goal guide whole: no pregnancy text is borrowed from the base guide', async () => {
    await applied((w) => {
      w.guides.rows = [...baseGuideRows().map((row) => (row.step === 'treat' ? { ...row, look_for_when_pregnant: 'Azelaic acid only.' } : row)), goalGuide({ goal: 'even-tone', look_for_when_pregnant: null })]
    })

    expect(await workbook().guideFor('treat', 'even-tone')).toMatchObject({ lookForWhenPregnant: null })
    expect(await workbook().guideFor('treat', 'glow')).toMatchObject({ lookForWhenPregnant: 'Azelaic acid only.' })
  })

  it('gives the base guide for a goal guide that is a draft, and for one that has been retired', async () => {
    await setGuides(goalGuide({ goal: 'glow', status: 'draft', approved_by: null, approved_on: null }), goalGuide({ goal: 'brighter' }))
    await setGuides(goalGuide({ goal: 'glow', status: 'draft', approved_by: null, approved_on: null }))

    expect(await workbook().guideFor('treat', 'glow')).toMatchObject({ whatItDoes: 'What treat does.' })
    expect(await workbook().guideFor('treat', 'brighter')).toMatchObject({ whatItDoes: 'What treat does.' })
  })

  it('reads what is live now: a changed base guide and a changed goal guide are given as changed after the upload', async () => {
    await setGuides(goalGuide())
    expect(await workbook().guideFor('treat', 'fade-dark-marks')).toMatchObject({ lookFor: 'Niacinamide or azelaic acid.' })

    await applied((w) => {
      w.guides.rows.find((row) => row.step === 'treat' && row.goal === 'fade-dark-marks')!.look_for = 'Azelaic acid.'
      w.guides.rows.find((row) => row.step === 'cleanse' && row.goal === null)!.look_for = 'A cream cleanser.'
    })

    expect(await workbook().guideFor('treat', 'fade-dark-marks')).toMatchObject({ lookFor: 'Azelaic acid.' })
    expect(await workbook().guideFor('cleanse', 'glow')).toMatchObject({ lookFor: 'A cream cleanser.' })
  })

  it('keeps one base row for each step however many times it is uploaded: the step with no goal is not a new row each time', async () => {
    await setGuides()
    await applied((w) => {
      w.guides.rows.find((row) => row.step === 'moisturise' && row.goal === null)!.for_deeper_skin = 'Newer text.'
    })
    await applied((w) => {
      w.guides.rows.find((row) => row.step === 'moisturise' && row.goal === null)!.for_deeper_skin = 'Newest text.'
    })

    const rows = (await exportLive()).workbook.guides.rows
    expect(rows.filter((row) => row.step === 'moisturise' && row.goal === null)).toEqual([expect.objectContaining({ for_deeper_skin: 'Newest text.' })])
    expect(await workbook().guideFor('moisturise', 'glow')).toMatchObject({ forDeeperSkin: 'Newest text.' })
  })
})

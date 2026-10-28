import { describe, expect, it } from 'vitest'
import { fillResponse, fillStep } from './skin-care.text'

describe('fillStep', () => {
  it('fills the step with its plain noun, every time it appears', () => {
    expect(fillStep('Pause your {step}. Skip the {step} tonight.', 'Treatment')).toBe('Pause your Treatment. Skip the Treatment tonight.')
  })

  it('says "your routine" when the answer is about no step', () => {
    expect(fillStep('Go gently with {step}.', null)).toBe('Go gently with your routine.')
  })

  it('leaves a text with no placeholder as it is', () => {
    expect(fillStep('Use a plain moisturiser.', 'Sunscreen')).toBe('Use a plain moisturiser.')
  })
})

describe('fillResponse', () => {
  it('fills the title, the body and what to do now', () => {
    expect(fillResponse({ title: 'Easing {step}', body: 'This is common with {step}.', whatToDoNow: 'Be gentle with {step}.' }, null)).toEqual({
      title: 'Easing your routine',
      body: 'This is common with your routine.',
      whatToDoNow: 'Be gentle with your routine.',
    })
  })

  it('keeps an empty what to do now empty', () => {
    expect(fillResponse({ title: 'T', body: 'B {step}', whatToDoNow: null }, 'Cleanser').whatToDoNow).toBeNull()
  })
})

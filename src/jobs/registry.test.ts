import { describe, expect, it } from 'vitest'
import { queueNames } from './job'
import { jobs } from './registry'

describe('the job registry', () => {
  it('lists the advance-scan-item job', () => {
    const job = jobs.find((j) => j.name === 'advance-scan-item')

    expect(job).toBeDefined()
    expect(job!.queue).toBe('scan-items')
    expect(job!.onDeadLetter).toBeTypeOf('function')
  })

  it('still lists the OTP delivery job', () => {
    expect(jobs.map((j) => j.name)).toContain('deliver-otp')
  })

  it('gives every job its own name and its own queue, so a backlog in one never delays another', () => {
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length)
    expect(new Set(jobs.map((j) => queueNames(j.queue, 'test').main)).size).toBe(jobs.length)
  })
})

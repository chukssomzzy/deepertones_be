import { describe, expect, it } from 'vitest'
import { parseEmailAddress } from '../../lib/email-address'
import type { EmailMessage } from './email.provider'
import { MemoryEmailSender } from './memory.email'

const ADA = parseEmailAddress('ada@example.com')
const BOB = parseEmailAddress('bob@example.com')

const message = (to = ADA, subject = 'Hi'): EmailMessage => ({ to, subject, html: '<p>hi</p>', text: 'hi' })

describe('MemoryEmailSender', () => {
  it('records sent messages in order', async () => {
    const sender = new MemoryEmailSender()
    const first = message(ADA, 'one')
    const second = message(BOB, 'two')

    await sender.send(first)
    await sender.send(second)

    expect(sender.sent).toEqual([first, second])
  })

  it('finds the latest message sent to an address', async () => {
    const sender = new MemoryEmailSender()
    await sender.send(message(ADA, 'old'))
    await sender.send(message(BOB, 'bob'))
    await sender.send(message(ADA, 'new'))

    expect(sender.lastTo(ADA)?.subject).toBe('new')
    expect(sender.lastTo(BOB)?.subject).toBe('bob')
  })

  it('returns undefined when nothing was sent to the address', () => {
    expect(new MemoryEmailSender().lastTo(ADA)).toBeUndefined()
  })

  it('failNextWith rejects the next send only, records nothing, then recovers', async () => {
    const sender = new MemoryEmailSender()
    const failure = new Error('boom')
    sender.failNextWith(failure)

    await expect(sender.send(message())).rejects.toBe(failure)
    expect(sender.sent).toEqual([])

    await expect(sender.send(message())).resolves.toBeUndefined()
    expect(sender.sent).toHaveLength(1)
  })
})

import { describe, expect, it } from 'vitest'
import type { PushMessage } from './push.provider'
import { MemoryPushSender } from './memory.push'

const ADA = 'ExponentPushToken[ada]'
const BOB = 'ExponentPushToken[bob]'

const message = (to = ADA, title = 'Hi'): PushMessage => ({ to, title, body: 'Body', data: { url: '/scans/s1' } })

describe('MemoryPushSender', () => {
  it('records sent messages in order across calls', async () => {
    const sender = new MemoryPushSender()
    const first = message(ADA, 'one')
    const second = message(BOB, 'two')
    const third = message(ADA, 'three')

    await sender.send([first, second])
    await sender.send([third])

    expect(sender.sent).toEqual([first, second, third])
  })

  it('answers every message with an ok ticket, numbered ticket-1, ticket-2 and so on across calls', async () => {
    const sender = new MemoryPushSender()

    const first = await sender.send([message(ADA), message(BOB)])
    const second = await sender.send([message(ADA)])

    expect(first).toEqual([
      { status: 'ok', id: 'ticket-1' },
      { status: 'ok', id: 'ticket-2' },
    ])
    expect(second).toEqual([{ status: 'ok', id: 'ticket-3' }])
  })

  it('sends nothing and returns no tickets for an empty batch', async () => {
    const sender = new MemoryPushSender()

    await expect(sender.send([])).resolves.toEqual([])
    expect(sender.sent).toEqual([])
  })

  it('ticketFor scripts the ticket for one token and leaves the others ok', async () => {
    const sender = new MemoryPushSender()
    sender.ticketFor(BOB, { status: 'error', reason: 'device-not-registered' })

    const tickets = await sender.send([message(ADA), message(BOB)])

    expect(tickets).toHaveLength(2)
    expect(tickets[0]).toMatchObject({ status: 'ok' })
    expect(tickets[1]).toEqual({ status: 'error', reason: 'device-not-registered' })
    expect(sender.sent.map((m) => m.to)).toEqual([ADA, BOB])
  })

  it('failNextWith rejects the next send only, records nothing, then recovers', async () => {
    const sender = new MemoryPushSender()
    const failure = new Error('boom')
    sender.failNextWith(failure)

    await expect(sender.send([message()])).rejects.toBe(failure)
    expect(sender.sent).toEqual([])

    await expect(sender.send([message()])).resolves.toHaveLength(1)
    expect(sender.sent).toHaveLength(1)
  })

  it('reports ok for a ticket it issued when no receipt is scripted', async () => {
    const sender = new MemoryPushSender()
    await sender.send([message(ADA), message(BOB)])

    await expect(sender.receipts(['ticket-1', 'ticket-2'])).resolves.toEqual({
      'ticket-1': { status: 'ok' },
      'ticket-2': { status: 'ok' },
    })
  })

  it('receiptFor scripts the receipt of one ticket and leaves the others ok', async () => {
    const sender = new MemoryPushSender()
    await sender.send([message(ADA), message(BOB)])
    sender.receiptFor('ticket-1', { status: 'error', reason: 'device-not-registered' })

    await expect(sender.receipts(['ticket-1', 'ticket-2'])).resolves.toEqual({
      'ticket-1': { status: 'error', reason: 'device-not-registered' },
      'ticket-2': { status: 'ok' },
    })
  })

  it('leaves out ids it never issued, like Expo does for a receipt that is not ready', async () => {
    const sender = new MemoryPushSender()
    await sender.send([message(ADA)])

    const receipts = await sender.receipts(['ticket-1', 'never-issued'])

    expect(Object.keys(receipts)).toEqual(['ticket-1'])
  })

  it('failNextReceiptsWith rejects the next receipts call only, then recovers', async () => {
    const sender = new MemoryPushSender()
    await sender.send([message(ADA)])
    const failure = new Error('boom')
    sender.failNextReceiptsWith(failure)

    await expect(sender.receipts(['ticket-1'])).rejects.toBe(failure)

    await expect(sender.receipts(['ticket-1'])).resolves.toEqual({ 'ticket-1': { status: 'ok' } })
  })

  it('failNextReceiptsWith leaves send alone, and failNextWith leaves receipts alone', async () => {
    const sender = new MemoryPushSender()
    sender.failNextReceiptsWith(new Error('receipts boom'))
    await expect(sender.send([message(ADA)])).resolves.toHaveLength(1)

    const other = new MemoryPushSender()
    await other.send([message(ADA)])
    other.failNextWith(new Error('send boom'))
    await expect(other.receipts(['ticket-1'])).resolves.toEqual({ 'ticket-1': { status: 'ok' } })
  })

  it('knows the id of a scripted ok ticket, so receipts reports it ok', async () => {
    const sender = new MemoryPushSender()
    sender.ticketFor(ADA, { status: 'ok', id: 'x' })

    const tickets = await sender.send([message(ADA)])

    expect(tickets).toEqual([{ status: 'ok', id: 'x' }])
    await expect(sender.receipts(['x'])).resolves.toEqual({ x: { status: 'ok' } })
  })

  it('lets receiptFor override the receipt of a scripted ok ticket', async () => {
    const sender = new MemoryPushSender()
    sender.ticketFor(ADA, { status: 'ok', id: 'x' })
    sender.receiptFor('x', { status: 'error', reason: 'device-not-registered' })
    await sender.send([message(ADA)])

    await expect(sender.receipts(['x'])).resolves.toEqual({ x: { status: 'error', reason: 'device-not-registered' } })
  })

  it('returns no receipts for no ids', async () => {
    await expect(new MemoryPushSender().receipts([])).resolves.toEqual({})
  })
})

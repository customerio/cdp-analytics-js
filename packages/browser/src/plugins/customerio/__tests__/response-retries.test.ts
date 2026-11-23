import unfetch from 'unfetch'
import { customerio, CustomerioSettings } from '..'
import { Analytics } from '../../../core/analytics'
import * as connection from '../../../core/connection'
import { Context } from '../../../core/context'
import { Plugin } from '../../../core/plugin'
import { PriorityQueue } from '../../../lib/priority-queue'
import { pageEnrichment } from '../../page-enrichment'
import { scheduleFlush } from '../schedule-flush'

jest.mock('unfetch', () => jest.fn())
jest.mock('../schedule-flush')

const respond = (status: number) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status } as Response)

describe('retrying requests the API did not accept', () => {
  let analytics: Analytics
  let cio: Plugin

  async function setup(
    deliveryStrategy?: CustomerioSettings['deliveryStrategy'],
    persist = false
  ): Promise<void> {
    analytics = new Analytics(
      { writeKey: 'foo' },
      { retryQueue: true, disableClientPersistence: !persist }
    )
    cio = customerio(analytics, { apiKey: 'foo', deliveryStrategy }, {})
    await analytics.register(cio, pageEnrichment)
  }

  // The plugin's own retry queue, as handed to scheduleFlush.
  function retryQueue(): PriorityQueue<Context> {
    expect(scheduleFlush).toHaveBeenCalled()
    return jest.mocked(scheduleFlush).mock.calls[0][1]
  }

  function sentBodies(): any[] {
    return jest
      .mocked(unfetch)
      .mock.calls.map(([, init]) => JSON.parse(init!.body as string))
  }

  beforeEach(() => {
    jest.resetAllMocks()
    jest.restoreAllMocks()
    jest.spyOn(connection, 'isOffline').mockReturnValue(false)
    localStorage.clear()
  })

  afterEach(() => {
    jest.useRealTimers()
    localStorage.clear()
  })

  describe('standard delivery', () => {
    beforeEach(() => setup())

    test.each([500, 502, 503, 504, 408, 429])(
      'queues an event answered with %i for another attempt',
      async (status) => {
        jest.mocked(unfetch).mockImplementation(() => respond(status))

        const ctx = await analytics.track('event')

        expect(unfetch).toHaveBeenCalledTimes(1)
        expect(retryQueue().todo).toBe(1)
        expect(retryQueue().pop()).toBe(ctx)
      }
    )

    test.each([400, 401, 403, 404, 413])(
      'does not retry an event answered with %i',
      async (status) => {
        jest.mocked(unfetch).mockImplementation(() => respond(status))

        await analytics.track('event')

        expect(unfetch).toHaveBeenCalledTimes(1)
        expect(scheduleFlush).not.toHaveBeenCalled()
      }
    )

    test('delivers an event answered with 500 when the retry gets a 200', async () => {
      jest
        .mocked(unfetch)
        .mockImplementationOnce(() => respond(500))
        .mockImplementationOnce(() => respond(200))

      const ctx = await analytics.track('event')
      const queued = retryQueue().pop()!
      await cio.track!(queued)

      expect(unfetch).toHaveBeenCalledTimes(2)
      expect(scheduleFlush).toHaveBeenCalledTimes(1)
      expect(retryQueue().todo).toBe(0)

      // The server dedupes resends by messageId.
      const [first, retried] = sentBodies()
      expect(first.messageId).toBe(ctx.event.messageId)
      expect(retried.messageId).toBe(first.messageId)
    })

    test('stops retrying at the attempt limit, backing off between attempts', async () => {
      jest.mocked(unfetch).mockImplementation(() => respond(500))

      const ctx = await analytics.track('event')
      const queue = retryQueue()
      // The first retry is queued straight away; later ones wait out a backoff.
      expect(queue.length).toBe(1)
      expect(ctx.logs().map((l) => l.message)).not.toContain(
        'Dropped after the last delivery attempt'
      )

      jest.useFakeTimers()
      for (let retry = 1; retry <= queue.maxAttempts; retry++) {
        if (queue.length === 0) {
          expect(queue.todo).toBe(1)
          jest.runOnlyPendingTimers()
        }
        await cio.track!(queue.pop()!)
      }

      // One send, then one retry for each attempt the queue allows.
      expect(unfetch).toHaveBeenCalledTimes(1 + queue.maxAttempts)
      expect(queue.todo).toBe(0)
      expect(ctx.logs().map((l) => l.message)).toContain(
        'Dropped after the last delivery attempt'
      )
    })

    test('a retry left at page exit is sent on the next load with the same messageId', async () => {
      await setup(undefined, true)
      jest.mocked(unfetch).mockImplementation(() => respond(500))
      const ctx = await analytics.track('event')
      expect(retryQueue().todo).toBe(1)

      window.dispatchEvent(new PageTransitionEvent('pagehide'))
      jest.mocked(scheduleFlush).mockClear()
      jest.mocked(unfetch).mockImplementation(() => respond(200))
      await setup(undefined, true)

      // The reloaded plugin starts flushing the persisted retry straight away.
      const restored = retryQueue().pop()!
      expect(restored.id).toBe(ctx.id)
      await cio.track!(restored)

      const [first, retried] = sentBodies()
      expect(first.messageId).toBe(ctx.event.messageId)
      expect(retried.messageId).toBe(first.messageId)
    })
  })

  describe('batching delivery', () => {
    beforeEach(() => setup({ strategy: 'batching', config: { size: 2 } }))

    test('retries every event of a batch answered with 500 until it gets a 200', async () => {
      jest
        .mocked(unfetch)
        .mockImplementationOnce(() => respond(500))
        .mockImplementationOnce(() => respond(200))

      const first = await analytics.track('first')
      const second = await analytics.track('second')

      expect(unfetch).toHaveBeenCalledTimes(1)
      const queue = retryQueue()
      expect(queue.todo).toBe(2)

      await cio.track!(queue.pop()!)
      await cio.track!(queue.pop()!)

      expect(unfetch).toHaveBeenCalledTimes(2)
      expect(scheduleFlush).toHaveBeenCalledTimes(2)
      expect(queue.todo).toBe(0)

      const [failed, retried] = sentBodies().map(({ batch }) =>
        batch.map((event: { messageId: string }) => event.messageId)
      )
      expect(failed).toEqual([first.event.messageId, second.event.messageId])
      expect(retried).toEqual(failed)
    })

    test.each([408, 429, 503])(
      'retries a batch answered with %i',
      async (status) => {
        jest.mocked(unfetch).mockImplementation(() => respond(status))

        await analytics.track('first')
        await analytics.track('second')

        expect(retryQueue().todo).toBe(2)
      }
    )

    test('does not retry a batch answered with 400', async () => {
      jest.mocked(unfetch).mockImplementation(() => respond(400))

      await analytics.track('first')
      await analytics.track('second')

      expect(unfetch).toHaveBeenCalledTimes(1)
      expect(scheduleFlush).not.toHaveBeenCalled()
    })
  })
})

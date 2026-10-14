/** @jest-environment node */
import { IDBFactory } from 'fake-indexeddb'
import { createWorker, readMetrics, worker } from './worker-harness'

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(1700000000000))
afterEach(() => jest.restoreAllMocks())

describe('web push metric outbox', () => {
  const setup = () => createWorker(worker)
  const relayMarkers = {
    'CIO-Delivery-ID': 'delivery',
    'CIO-Delivery-Token': 'endpoint',
  }
  const click = (
    delivery_id = 'delivery',
    device_id = 'endpoint',
    action = ''
  ) => ({
    action,
    notification: {
      close: jest.fn(),
      data: { delivery_id, device_id, link: '/destination' },
    },
  })

  test('HTTP 5xx is queued, backs off, and retries the original report on sync', async () => {
    const s = setup()
    await s.startup
    s.fetch.mockResolvedValueOnce({ ok: false, status: 503 })
    await s.invoke('notificationclick', click('delivery', 'endpoint', 'view'))
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(s.sync.register).toHaveBeenCalledWith('cio-webpush-metrics')
    const [queued] = await readMetrics(s.indexedDB)
    expect(queued).toMatchObject({
      done: false,
      attempts: 1,
      nextAttempt: 1700000030000,
    })
    await expect(
      s.invoke('sync', { tag: 'cio-webpush-metrics' })
    ).rejects.toThrow('metrics pending')
    expect(s.fetch).toHaveBeenCalledTimes(1)
    jest.spyOn(Date, 'now').mockReturnValue(1700000030000)
    await s.invoke('sync', { tag: 'cio-webpush-metrics' })
    expect(s.fetch).toHaveBeenCalledTimes(2)
    expect(s.fetch.mock.calls[1][1].body).toBe(s.fetch.mock.calls[0][1].body)
    expect((await readMetrics(s.indexedDB))[0].done).toBe(true)
  })

  test('offline reports survive worker restart and retry on startup', async () => {
    const s = setup()
    await s.startup
    s.fetch.mockRejectedValue(new Error('offline'))
    await s.invoke('notificationclick', click())
    expect((await readMetrics(s.indexedDB))[0].done).toBe(false)
    jest.spyOn(Date, 'now').mockReturnValue(1700000030000)
    const restarted = createWorker(worker, undefined, {}, s.indexedDB)
    await restarted.startup
    expect(restarted.fetch).toHaveBeenCalledTimes(1)
    expect((await readMetrics(s.indexedDB))[0].done).toBe(true)
    await restarted.invoke('notificationclick', click())
    expect(restarted.fetch).toHaveBeenCalledTimes(1)
  })

  test.each(['push', 'notificationclick'])(
    '%s retries a due failed report without delaying display/navigation',
    async (event) => {
      const s = setup()
      await s.startup
      s.fetch.mockRejectedValueOnce(new Error('offline'))
      await s.invoke('notificationclick', click())
      jest.spyOn(Date, 'now').mockReturnValue(1700000030000)
      await s.invoke(
        event,
        event === 'push'
          ? {
              data: {
                json: () => ({ ...relayMarkers, 'CIO-Delivery-ID': 'another' }),
              },
            }
          : click('another')
      )
      expect(
        s.fetch.mock.calls.filter(
          ([, options]) => JSON.parse(options.body).delivery_id === 'delivery'
        )
      ).toHaveLength(2)
      expect(
        (await readMetrics(s.indexedDB)).every((record) => record.done)
      ).toBe(true)
    }
  )

  test('concurrent clicks and different actions share one report; device/event remain distinct', async () => {
    const s = setup()
    await Promise.all([
      s.invoke('notificationclick', click('delivery', 'endpoint', 'view')),
      s.invoke('notificationclick', click('delivery', 'endpoint', 'other')),
    ])
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(s.openWindow).toHaveBeenCalledTimes(2)
    await s.invoke('notificationclick', click('delivery', 'other-device'))
    await s.invoke('push', { data: { json: () => relayMarkers } })
    expect(s.fetch).toHaveBeenCalledTimes(3)
  })

  test('overlapping workers atomically lease a pending report', async () => {
    const s = setup()
    await s.startup
    s.fetch.mockRejectedValue(new Error('offline'))
    await s.invoke('notificationclick', click())
    jest.spyOn(Date, 'now').mockReturnValue(1700000030000)
    const a = createWorker(worker, undefined, {}, s.indexedDB)
    const b = createWorker(worker, undefined, {}, s.indexedDB)
    await Promise.all([a.startup, b.startup])
    expect(a.fetch.mock.calls.length + b.fetch.mock.calls.length).toBe(1)
  })

  test('repeated failures increase backoff and do not cause a busy retry loop', async () => {
    const s = setup()
    await s.startup
    s.fetch.mockResolvedValue({ ok: false, status: 500 })
    await s.invoke('notificationclick', click())
    jest.spyOn(Date, 'now').mockReturnValue(1700000030000)
    await s.invoke('notificationclick', click())
    expect((await readMetrics(s.indexedDB))[0]).toMatchObject({
      attempts: 2,
      nextAttempt: 1700000090000,
    })
    await s.invoke('notificationclick', click())
    expect(s.fetch).toHaveBeenCalledTimes(2)
  })

  test('backoff caps at one hour', async () => {
    const s = setup()
    await s.startup
    s.fetch.mockRejectedValue(new Error('offline'))
    await s.invoke('notificationclick', click())
    for (let i = 0; i < 10; i++) {
      const [record] = await readMetrics(s.indexedDB)
      jest.spyOn(Date, 'now').mockReturnValue(record.nextAttempt)
      await s.invoke('notificationclick', click())
    }
    const [record] = await readMetrics(s.indexedDB)
    expect(record.nextAttempt - Date.now()).toBe(3600000)
  })

  test('storage denial leaves showing and opening notifications intact', async () => {
    const indexedDB = new IDBFactory()
    jest.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new Error('Storage denied')
    })
    const s = createWorker(worker, undefined, {}, indexedDB)
    await s.invoke('push', { data: { json: () => relayMarkers } })
    await s.invoke('notificationclick', click())
    expect(s.fetch).toHaveBeenCalledTimes(2)
    expect(
      s.fetch.mock.calls.map(([, options]) => JSON.parse(options.body).event)
    ).toEqual(['delivered', 'opened'])
    expect(s.sync.register).not.toHaveBeenCalled()
    expect(s.showNotification).toHaveBeenCalledTimes(1)
    expect(s.openWindow).toHaveBeenCalledWith('https://example.com/destination')
    expect(s.warn).toHaveBeenCalledWith(
      'Customer.io web push metric storage failed:',
      expect.anything()
    )
  })

  test('a slow startup retry cannot delay displaying a new notification', async () => {
    const s = setup()
    await s.startup
    s.fetch.mockRejectedValue(new Error('offline'))
    await s.invoke('notificationclick', click())
    jest.spyOn(Date, 'now').mockReturnValue(1700000030000)
    const restarted = createWorker(worker, undefined, {}, s.indexedDB)
    restarted.fetch.mockImplementation(() => new Promise(() => {}))
    void restarted.invoke('push', { data: { json: () => relayMarkers } })
    expect(restarted.showNotification).toHaveBeenCalledTimes(1)
  })

  test('pending queue evicts oldest at 100 and expires after seven days', async () => {
    const s = setup()
    await s.startup
    s.fetch.mockRejectedValue(new Error('offline'))
    for (let i = 0; i < 101; i++) {
      jest.spyOn(Date, 'now').mockReturnValue(1700000000000 + i)
      await s.invoke('notificationclick', click(`delivery-${i}`))
    }
    const records = await readMetrics(s.indexedDB)
    expect(records).toHaveLength(100)
    expect(
      records.some((record) => record.body.delivery_id === 'delivery-0')
    ).toBe(false)
    jest.spyOn(Date, 'now').mockReturnValue(1700000000100 + 7 * 86400000)
    await s.invoke('sync', { tag: 'cio-webpush-metrics' })
    expect(await readMetrics(s.indexedDB)).toHaveLength(0)
    expect(s.fetch).toHaveBeenCalledTimes(101)
  })

  test('acknowledged receipts are bounded to 1000 records', async () => {
    const s = setup()
    await s.startup
    for (let i = 0; i < 1001; i++) {
      await s.invoke('notificationclick', click(`delivery-${i}`))
    }
    const records = await readMetrics(s.indexedDB)
    expect(records).toHaveLength(1000)
    expect(records.every((record) => record.done)).toBe(true)
  }, 30000)

  test.each([400, 401, 403, 404, 410, 422])(
    'HTTP %s is final and suppresses replay',
    async (status) => {
      const s = setup()
      await s.startup
      s.fetch.mockResolvedValue({ ok: false, status })
      await s.invoke('notificationclick', click())
      expect((await readMetrics(s.indexedDB))[0].done).toBe(true)
      jest.spyOn(Date, 'now').mockReturnValue(1700000030000)
      await s.invoke('sync', { tag: 'cio-webpush-metrics' })
      await s.invoke('notificationclick', click())
      expect(s.fetch).toHaveBeenCalledTimes(1)
      expect(s.sync.register).not.toHaveBeenCalled()
    }
  )

  test.each([408, 429])('HTTP %s remains retryable', async (status) => {
    const s = setup()
    await s.startup
    s.fetch.mockResolvedValueOnce({ ok: false, status })
    await s.invoke('notificationclick', click())
    expect((await readMetrics(s.indexedDB))[0].done).toBe(false)
    jest.spyOn(Date, 'now').mockReturnValue(1700000030000)
    await s.invoke('sync', { tag: 'cio-webpush-metrics' })
    expect(s.fetch).toHaveBeenCalledTimes(2)
  })

  test('missing IndexedDB still sends directly once even if the network fails', async () => {
    const s = createWorker(worker, undefined, {}, undefined, {
      indexedDB: undefined,
    })
    s.fetch.mockRejectedValue(new Error('offline'))
    await s.invoke('notificationclick', click())
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(s.sync.register).not.toHaveBeenCalled()
    expect(s.openWindow).toHaveBeenCalledTimes(1)
  })

  test('an aborted save falls back to exactly one direct send', async () => {
    const s = setup()
    await s.startup
    const open = s.indexedDB.open('cio-webpush-metrics', 1)
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result)
    })
    const prototype = Object.getPrototypeOf(db)
    const transactionMethod = prototype.transaction
    jest
      .spyOn(prototype, 'transaction')
      .mockImplementation(function (this: IDBDatabase, ...args: unknown[]) {
        const transaction = transactionMethod.apply(this, args)
        // Abort after the write was requested, before the save commits.
        const store = transaction.objectStore('events')
        const put = store.put.bind(store)
        jest.spyOn(store, 'put').mockImplementation((value) => {
          const request = put(value)
          transaction.abort()
          return request
        })
        jest.spyOn(transaction, 'objectStore').mockReturnValue(store)
        return transaction
      })
    await s.invoke('notificationclick', click())
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(s.sync.register).not.toHaveBeenCalled()
    db.close()
  })

  test('a failed save falls back to exactly one direct send', async () => {
    const s = setup()
    await s.startup
    const open = s.indexedDB.open('cio-webpush-metrics', 1)
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result)
    })
    const prototype = Object.getPrototypeOf(db)
    jest.spyOn(prototype, 'transaction').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    await s.invoke('notificationclick', click())
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(s.fetch.mock.calls[0][1].body).event).toBe('opened')
    expect(s.sync.register).not.toHaveBeenCalled()
    db.close()
  })

  test('activate completes while a large startup backlog is stuck sending', async () => {
    const s = setup()
    await s.startup
    s.fetch.mockRejectedValue(new Error('offline'))
    for (let i = 0; i < 100; i++) {
      await s.invoke('notificationclick', click(`delivery-${i}`))
    }
    jest.spyOn(Date, 'now').mockReturnValue(1700000030000)
    let started!: () => void
    const sending = new Promise<void>((resolve) => {
      started = resolve
    })
    const fetch = jest.fn(() => {
      started()
      return new Promise(() => {})
    })
    const restarted = createWorker(worker, undefined, {}, s.indexedDB, {
      fetch,
    })
    await sending
    await restarted.invoke('activate', {})
    expect(restarted.claim).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await readMetrics(s.indexedDB)).toHaveLength(100)
  })

  test('pending records use their original URL after track is removed', async () => {
    const s = setup()
    await s.startup
    s.fetch.mockRejectedValue(new Error('offline'))
    await s.invoke('notificationclick', click())
    jest.spyOn(Date, 'now').mockReturnValue(1700000030000)
    const restarted = createWorker(
      worker,
      'https://example.com/host-sw.js',
      {},
      s.indexedDB
    )
    await restarted.startup
    expect(restarted.fetch).toHaveBeenCalledWith(
      'https://track.customer.io/push/events',
      expect.anything()
    )
    await restarted.invoke('notificationclick', click('new'))
    expect(restarted.fetch).toHaveBeenCalledTimes(1)
  })

  test('opened waits for its delivered report to finish backoff', async () => {
    const s = setup()
    await s.startup
    s.fetch.mockRejectedValueOnce(new Error('offline'))
    await s.invoke('push', { data: { json: () => relayMarkers } })
    await s.invoke('notificationclick', click())
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(s.openWindow).toHaveBeenCalledTimes(1)
    jest.spyOn(Date, 'now').mockReturnValue(1700000030000)
    await s.invoke('sync', { tag: 'cio-webpush-metrics' })
    expect(
      s.fetch.mock.calls.map(([, options]) => JSON.parse(options.body).event)
    ).toEqual(['delivered', 'delivered', 'opened'])
  })

  test('a worker killed mid-send leaves a lease that retries once after backoff', async () => {
    const s = setup()
    await s.startup
    let started!: () => void
    const sending = new Promise<void>((resolve) => {
      started = resolve
    })
    s.fetch.mockImplementation(() => {
      started()
      return new Promise(() => {})
    })
    void s.invoke('notificationclick', click())
    await sending
    expect((await readMetrics(s.indexedDB))[0]).toMatchObject({
      done: false,
      attempts: 1,
    })
    const early = createWorker(worker, undefined, {}, s.indexedDB)
    await early.startup
    expect(early.fetch).not.toHaveBeenCalled()
    jest.spyOn(Date, 'now').mockReturnValue(1700000030000)
    const restarted = createWorker(worker, undefined, {}, s.indexedDB)
    await restarted.startup
    await restarted.invoke('notificationclick', click())
    expect(restarted.fetch).toHaveBeenCalledTimes(1)
    expect((await readMetrics(s.indexedDB))[0].done).toBe(true)
  })

  test('importScripts lifecycle opt-out still retries without global-name collisions', async () => {
    const s = createWorker(worker, undefined, { cioWebPushLifecycle: false })
    await s.startup
    s.fetch.mockRejectedValueOnce(new Error('offline'))
    await s.invoke('notificationclick', click())
    jest.spyOn(Date, 'now').mockReturnValue(1700000030000)
    const restarted = createWorker(
      worker,
      undefined,
      { cioWebPushLifecycle: false },
      s.indexedDB
    )
    await restarted.startup
    await restarted.invoke('install', {})
    await restarted.invoke('activate', {})
    expect(restarted.skipWaiting).not.toHaveBeenCalled()
    expect(restarted.claim).not.toHaveBeenCalled()
    expect(restarted.fetch).toHaveBeenCalledTimes(1)
  })

  test('missing AbortSignal.timeout still sends and successful sends do not register sync', async () => {
    const s = createWorker(worker, undefined, {}, undefined, {
      AbortSignal: {},
    })
    await s.startup
    await s.invoke('notificationclick', click())
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(s.fetch.mock.calls[0][1].signal).toBeUndefined()
    expect((await readMetrics(s.indexedDB))[0].done).toBe(true)
    expect(s.sync.register).not.toHaveBeenCalled()
  })

  test('a missing track URL does not create or send metrics', async () => {
    const s = createWorker(worker, 'https://example.com/cio-webpush-sw.js')
    await s.invoke('notificationclick', click())
    expect(s.fetch).not.toHaveBeenCalled()
    expect(await s.indexedDB.databases()).toEqual([])
  })
})

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
    await restarted.invoke('notificationclose', {})
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

  test('a missing track URL does not create or send metrics', async () => {
    const s = createWorker(worker, 'https://example.com/cio-webpush-sw.js')
    await s.invoke('notificationclick', click())
    expect(s.fetch).not.toHaveBeenCalled()
    expect(await s.indexedDB.databases()).toEqual([])
  })
})

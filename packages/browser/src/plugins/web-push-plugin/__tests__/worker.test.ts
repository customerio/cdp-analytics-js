import fs from 'fs'
import path from 'path'
import vm from 'vm'

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(1700000000000))
afterEach(() => jest.restoreAllMocks())

// The build ships this file unchanged as dist/cio-webpush-sw.js and fails if
// the emitted copy differs (webpack.config.js), so the source is what's tested.
const worker = path.join(__dirname, '../cio-webpush-sw.js')

function createWorker(worker: string) {
  const listeners: Record<string, (event: any) => void> = {}
  const fetch = jest.fn().mockResolvedValue({ ok: true })
  const showNotification = jest.fn().mockResolvedValue(undefined)
  const openWindow = jest.fn().mockResolvedValue(undefined)
  const postMessage = jest.fn()
  const pushManager = {
    getSubscription: jest.fn().mockResolvedValue({ endpoint: 'endpoint' }),
    subscribe: jest.fn().mockResolvedValue({}),
  }
  const self = {
    location: {
      href: 'https://example.com/cio-webpush-sw.js?track=https%3A%2F%2Ftrack.customer.io',
    },
    addEventListener: (name: string, fn: (event: any) => void) => {
      listeners[name] = fn
    },
    registration: { showNotification, pushManager },
    clients: {
      openWindow,
      matchAll: jest.fn().mockResolvedValue([{ postMessage }]),
    },
  }
  vm.runInNewContext(fs.readFileSync(worker, 'utf8'), {
    self,
    fetch,
    URL,
    Date,
    AbortSignal: { timeout: jest.fn(() => 'timeout-signal') },
    console: { warn: jest.fn() },
  })
  const invoke = (name: string, event: any) => {
    let task: Promise<unknown> = Promise.resolve()
    listeners[name]?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => {
        task = promise
      },
    })
    return task
  }
  return {
    invoke,
    fetch,
    showNotification,
    openWindow,
    postMessage,
    pushManager,
  }
}

describe('cio-webpush-sw.js', () => {
  const setup = () => createWorker(worker)

  test('push shows the notification, then sends a text-body delivered metric', async () => {
    const s = setup()
    await s.invoke('push', {
      data: {
        json: () => ({
          title: 'Title',
          body: 'Body',
          image: '/image.png',
          icon: '/icon.png',
          badge: '/badge.png',
          actions: [
            {
              action: 'view',
              title: 'View',
              url: 'https://example.com/view',
              unknown: true,
            },
            { action: 'later', title: 'Later' },
            { action: 'third', title: 'Third' },
          ],
          custom_data: { ignored: true },
          unknown: true,
          link: '/destination',
          'CIO-Delivery-ID': 'delivery',
          'CIO-Delivery-Token': 'endpoint',
        }),
      },
    })
    expect(s.showNotification).toHaveBeenCalledWith('Title', {
      body: 'Body',
      image: '/image.png',
      icon: '/icon.png',
      badge: '/badge.png',
      actions: [
        { action: 'view', title: 'View' },
        { action: 'later', title: 'Later' },
      ],
      data: {
        link: '/destination',
        actions: [
          { action: 'view', title: 'View', url: 'https://example.com/view' },
          { action: 'later', title: 'Later', url: undefined },
        ],
        delivery_id: 'delivery',
        device_id: 'endpoint',
      },
    })
    expect(s.fetch).toHaveBeenCalledWith(
      'https://track.customer.io/push/events',
      {
        method: 'POST',
        signal: 'timeout-signal',
        body: JSON.stringify({
          delivery_id: 'delivery',
          device_id: 'endpoint',
          event: 'delivered',
          timestamp: Math.floor(Date.now() / 1000),
        }),
      }
    )
    expect(s.showNotification.mock.invocationCallOrder[0]).toBeLessThan(
      s.fetch.mock.invocationCallOrder[0]
    )
  })

  test('click navigates even when metrics fail or never settle', async () => {
    const s = setup()
    s.fetch.mockRejectedValue(new Error('offline'))
    const close = jest.fn()
    await s.invoke('notificationclick', {
      notification: {
        close,
        data: { link: '/destination', delivery_id: 'delivery' },
      },
    })
    expect(close).toHaveBeenCalled()
    expect(s.openWindow).toHaveBeenCalledWith('/destination')
    expect(JSON.parse(s.fetch.mock.calls[0][1].body).event).toBe('opened')
    s.fetch.mockImplementation(() => new Promise(() => {}))
    void s.invoke('notificationclick', {
      notification: { close, data: { link: '/slow', delivery_id: 'delivery' } },
    })
    expect(s.openWindow).toHaveBeenCalledWith('/slow')
  })

  test('invalid JSON still shows a notification but sends no incomplete metric', async () => {
    const s = setup()
    await s.invoke('push', {
      data: {
        json: () => {
          throw new Error('invalid')
        },
      },
    })
    expect(s.showNotification).toHaveBeenCalled()
    expect(s.fetch).not.toHaveBeenCalled()
  })

  test('subscription change renews using the old key and notifies open pages', async () => {
    const s = setup()
    const options = { userVisibleOnly: true, applicationServerKey: 'key' }
    await s.invoke('pushsubscriptionchange', { oldSubscription: { options } })
    expect(s.pushManager.subscribe).toHaveBeenCalledWith(options)
    expect(s.postMessage).toHaveBeenCalledWith({
      type: 'cio-webpush-subscriptionchange',
    })
  })

  test('minimal payload uses only default options and no metrics', async () => {
    const s = setup()
    await s.invoke('push', { data: { json: () => ({ title: 'Minimal' }) } })
    expect(s.showNotification).toHaveBeenCalledWith('Minimal', {
      body: undefined,
      image: undefined,
      icon: undefined,
      badge: undefined,
      actions: [],
      data: {
        link: undefined,
        actions: [],
        delivery_id: undefined,
        device_id: undefined,
      },
    })
    expect(s.fetch).not.toHaveBeenCalled()
  })

  test.each([
    undefined,
    null,
    {},
    'invalid',
    [
      null,
      1,
      'invalid',
      {},
      { action: 1, title: 'Bad' },
      { action: 'bad', title: 1 },
      { action: 'bad', title: '' },
      { action: 'BAD', title: 'Bad' },
      { action: 'bad', title: 'x'.repeat(33) },
      { action: 'bad', title: 'Bad', url: 'not a URL' },
      { action: 'bad', title: 'Bad', url: 'http://example.com' },
      { action: 'bad', title: 'Bad', url: {} },
    ],
  ])('drops malformed actions: %j', async (actions) => {
    const s = setup()
    await s.invoke('push', {
      data: { json: () => ({ title: 'Title', actions }) },
    })
    expect(s.showNotification.mock.calls[0][1].actions).toEqual([])
    expect(s.showNotification.mock.calls[0][1].data.actions).toEqual([])
  })

  // The label boundary cases services and the composer test too.
  test.each([
    ['a'.repeat(32), 'a'.repeat(32)],
    ['a'.repeat(33), null],
    ['😀'.repeat(32), '😀'.repeat(32)],
    ['😀'.repeat(33), null],
    ['👍🏽'.repeat(16), '👍🏽'.repeat(16)],
    ['👍🏽'.repeat(17), null],
    ['  ' + 'a'.repeat(32) + '  ', 'a'.repeat(32)],
    ['   ', null],
    ['\uFEFF', null],
    ['\u0085', null],
    ['\uFEFF' + 'a'.repeat(32) + '\u0085', 'a'.repeat(32)],
  ])('a label counts code points once trimmed: %j', async (title, shown) => {
    const s = setup()
    await s.invoke('push', {
      data: {
        json: () => ({ title: 'Title', actions: [{ action: 'view', title }] }),
      },
    })
    expect(s.showNotification.mock.calls[0][1].actions).toEqual(
      shown === null ? [] : [{ action: 'view', title: shown }]
    )
  })

  test('invalid and duplicate entries do not displace valid actions', async () => {
    const s = setup()
    await s.invoke('push', {
      data: {
        json: () => ({
          actions: [
            null,
            { action: 'view', title: 'View' },
            { action: 'view', title: 'Duplicate' },
            { action: 'later', title: 'Later' },
          ],
        }),
      },
    })
    expect(s.showNotification.mock.calls[0][1].actions).toEqual([
      { action: 'view', title: 'View' },
      { action: 'later', title: 'Later' },
    ])
  })

  test.each([
    ['', '/destination'],
    ['view', 'https://example.com/view'],
    ['later', '/destination'],
    ['unknown', '/destination'],
  ])(
    'click %s navigates and reports the action without delaying navigation',
    async (action, url) => {
      const s = setup()
      const close = jest.fn()
      const notification = {
        close,
        data: {
          link: '/destination',
          delivery_id: 'delivery',
          actions: [
            { action: 'view', title: 'View', url: 'https://example.com/view' },
            { action: 'later', title: 'Later' },
          ],
        },
      }
      await s.invoke('notificationclick', { action, notification })
      expect(close).toHaveBeenCalled()
      expect(s.openWindow).toHaveBeenCalledWith(url)
      expect(JSON.parse(s.fetch.mock.calls[0][1].body)).toEqual({
        delivery_id: 'delivery',
        device_id: 'endpoint',
        event: 'opened',
        timestamp: 1700000000,
        ...(action ? { action } : {}),
      })
      s.fetch.mockImplementation(() => new Promise(() => {}))
      s.openWindow.mockClear()
      void s.invoke('notificationclick', { action, notification })
      expect(s.openWindow).toHaveBeenCalledWith(url)
    }
  )

  test('closing a notification makes no network call', async () => {
    const s = setup()
    await s.invoke('notificationclose', {
      notification: { data: { delivery_id: 'delivery' } },
    })
    expect(s.fetch).not.toHaveBeenCalled()
    expect(s.openWindow).not.toHaveBeenCalled()
  })
})

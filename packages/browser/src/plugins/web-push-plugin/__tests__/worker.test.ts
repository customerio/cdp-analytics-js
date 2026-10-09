import fs from 'fs'
import path from 'path'
import vm from 'vm'

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(1700000000000))
afterEach(() => jest.restoreAllMocks())

// The build ships this file unchanged as dist/cio-webpush-sw.js and fails if
// the emitted copy differs (webpack.config.js), so the source is what's tested.
const worker = path.join(__dirname, '../cio-webpush-sw.js')

function createWorker(
  worker: string,
  workerUrl = 'https://example.com/cio-webpush-sw.js?track=https%3A%2F%2Ftrack.customer.io',
  globals: Record<string, unknown> = {}
) {
  const listeners: Record<string, (event: any) => void> = {}
  const fetch = jest.fn().mockResolvedValue({ ok: true })
  const showNotification = jest.fn().mockResolvedValue(undefined)
  const openWindow = jest.fn().mockResolvedValue(undefined)
  const postMessage = jest.fn()
  const pushManager = {
    getSubscription: jest.fn().mockResolvedValue({ endpoint: 'endpoint' }),
    subscribe: jest.fn().mockResolvedValue({}),
  }
  const skipWaiting = jest.fn().mockResolvedValue(undefined)
  const claim = jest.fn().mockResolvedValue(undefined)
  const self = {
    ...globals,
    skipWaiting,
    location: {
      href: workerUrl,
      origin: new URL(workerUrl).origin,
    },
    addEventListener: (name: string, fn: (event: any) => void) => {
      listeners[name] = fn
    },
    registration: { showNotification, pushManager },
    clients: {
      claim,
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
    skipWaiting,
    claim,
    fetch,
    showNotification,
    openWindow,
    postMessage,
    pushManager,
  }
}

describe('cio-webpush-sw.js', () => {
  const setup = () => createWorker(worker)
  const relayMarkers = {
    'CIO-Delivery-ID': 'delivery',
    'CIO-Delivery-Token': 'endpoint',
  }
  const notificationMarkers = { delivery_id: 'delivery', device_id: 'endpoint' }

  test('install and activate take over the page by default', async () => {
    const s = setup()
    await s.invoke('install', {})
    await s.invoke('activate', {})
    expect(s.skipWaiting).toHaveBeenCalledTimes(1)
    expect(s.claim).toHaveBeenCalledTimes(1)
  })

  test('an importing host opts out of the lifecycle and keeps push handling', async () => {
    const s = createWorker(worker, undefined, { cioWebPushLifecycle: false })
    await s.invoke('install', {})
    await s.invoke('activate', {})
    expect(s.skipWaiting).not.toHaveBeenCalled()
    expect(s.claim).not.toHaveBeenCalled()
    await s.invoke('push', {
      data: { json: () => ({ ...relayMarkers, title: 'Imported' }) },
    })
    expect(s.showNotification).toHaveBeenCalledWith(
      'Imported',
      expect.anything()
    )
  })

  test('push shows the notification, then sends a text-body delivered metric', async () => {
    const s = setup()
    await s.invoke('push', {
      data: {
        json: () => ({
          ...relayMarkers,
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
        data: {
          ...notificationMarkers,
          link: '/destination',
          delivery_id: 'delivery',
        },
      },
    })
    expect(close).toHaveBeenCalled()
    expect(s.openWindow).toHaveBeenCalledWith('https://example.com/destination')
    expect(JSON.parse(s.fetch.mock.calls[0][1].body).event).toBe('opened')
    s.fetch.mockImplementation(() => new Promise(() => {}))
    void s.invoke('notificationclick', {
      notification: {
        close,
        data: {
          ...notificationMarkers,
          link: '/slow',
          delivery_id: 'delivery',
        },
      },
    })
    expect(s.openWindow).toHaveBeenCalledWith('https://example.com/slow')
  })

  test.each([
    'javascript:alert(1)',
    'blob:https://example.com/stale-id',
    'data:text/html,unsafe',
    'http://other.example/orders',
    'https://[',
    { href: 'https://example.com/orders' },
    123,
    null,
    '',
    '   ',
  ])('an unsafe body link falls back to the origin root: %j', async (link) => {
    const s = setup()
    await s.invoke('notificationclick', {
      notification: {
        close: jest.fn(),
        data: { ...notificationMarkers, link },
      },
    })
    expect(s.openWindow).toHaveBeenCalledWith('/')
  })

  test.each([
    ['https://other.example/orders', 'https://other.example/orders'],
    ['/orders?q=1', 'https://example.com/orders?q=1'],
  ])(
    'a safe body link %s opens its resolved HTTPS URL',
    async (link, destination) => {
      const s = setup()
      await s.invoke('notificationclick', {
        notification: {
          close: jest.fn(),
          data: { ...notificationMarkers, link },
        },
      })
      expect(s.openWindow).toHaveBeenCalledWith(destination)
    }
  )

  const nestedWorkerUrl =
    'https://shop.example/notifications/cio-webpush-sw.js?track=https%3A%2F%2Ftrack.customer.io'

  // Relative links resolve against the site origin, not the worker's path.
  test.each([
    ['orders', 'https://shop.example/orders'],
    ['./orders', 'https://shop.example/orders'],
    ['../orders', 'https://shop.example/orders'],
    ['/orders', 'https://shop.example/orders'],
    ['?q=1', 'https://shop.example/?q=1'],
    ['#top', 'https://shop.example/#top'],
  ])(
    'a nested worker resolves body link %s from the site origin',
    async (link, destination) => {
      const s = createWorker(worker, nestedWorkerUrl)
      await s.invoke('notificationclick', {
        notification: {
          close: jest.fn(),
          data: { ...notificationMarkers, link },
        },
      })
      expect(s.openWindow).toHaveBeenCalledWith(destination)
    }
  )

  test('a nested worker button without a URL uses the resolved body link', async () => {
    const s = createWorker(worker, nestedWorkerUrl)
    await s.invoke('notificationclick', {
      action: 'later',
      notification: {
        close: jest.fn(),
        data: {
          ...notificationMarkers,
          link: 'orders',
          actions: [{ action: 'later', title: 'Later' }],
        },
      },
    })
    expect(s.openWindow).toHaveBeenCalledWith('https://shop.example/orders')
  })

  test.each([
    'http://localhost:8000/orders',
    '/orders',
    'http://other.example/orders',
    '//other.example/orders',
  ])('an HTTP development worker opens only HTTPS links: %s', async (link) => {
    const s = createWorker(worker, 'http://localhost:8000/cio-webpush-sw.js')
    await s.invoke('notificationclick', {
      notification: {
        close: jest.fn(),
        data: { ...notificationMarkers, link },
      },
    })
    expect(s.openWindow).toHaveBeenCalledWith('/')
  })

  test.each([
    ['javascript:alert(1)', '/orders', 'https://example.com/orders'],
    [
      'blob:https://example.com/stale-id',
      '/orders',
      'https://example.com/orders',
    ],
    ['https://[', '/orders', 'https://example.com/orders'],
    ['http://other.example/orders', '/orders', 'https://example.com/orders'],
    ['javascript:alert(1)', 'data:text/html,unsafe', '/'],
  ])(
    'an unsafe stored button URL %s uses a safe body fallback',
    async (url, link, destination) => {
      const s = setup()
      await s.invoke('notificationclick', {
        action: 'view',
        notification: {
          close: jest.fn(),
          data: {
            ...notificationMarkers,
            link,
            actions: [{ action: 'view', url }],
          },
        },
      })
      expect(s.openWindow).toHaveBeenCalledWith(destination)
    }
  )

  test('invalid JSON cannot claim a notification in a shared worker', async () => {
    const s = setup()
    await s.invoke('push', {
      data: {
        json: () => {
          throw new Error('invalid')
        },
      },
    })
    expect(s.showNotification).not.toHaveBeenCalled()
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

  test('a minimal Customer.io payload uses default options and reports delivery', async () => {
    const s = setup()
    await s.invoke('push', {
      data: { json: () => ({ ...relayMarkers, title: 'Minimal' }) },
    })
    expect(s.showNotification).toHaveBeenCalledWith('Minimal', {
      body: undefined,
      image: undefined,
      icon: undefined,
      badge: undefined,
      actions: [],
      data: {
        link: undefined,
        actions: [],
        delivery_id: 'delivery',
        device_id: 'endpoint',
      },
    })
    expect(s.fetch).toHaveBeenCalled()
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
      data: { json: () => ({ ...relayMarkers, title: 'Title', actions }) },
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
        json: () => ({
          ...relayMarkers,
          title: 'Title',
          actions: [{ action: 'view', title }],
        }),
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
          ...relayMarkers,
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
    ['', 'https://example.com/destination'],
    ['view', 'https://example.com/view'],
    ['later', 'https://example.com/destination'],
    ['unknown', 'https://example.com/destination'],
  ])(
    'click %s navigates and reports the action without delaying navigation',
    async (action, url) => {
      const s = setup()
      const close = jest.fn()
      const notification = {
        close,
        data: {
          ...notificationMarkers,
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

  test.each([
    { title: 'Another provider', body: 'A foreign message' },
    { 'CIO-Delivery-ID': 'delivery' },
    { 'CIO-Delivery-Token': 'endpoint' },
    { 'CIO-Delivery-ID': 42, 'CIO-Delivery-Token': 'endpoint' },
    { 'CIO-Delivery-ID': 'delivery', 'CIO-Delivery-Token': '' },
    null,
    [],
  ])(
    'a shared worker leaves an unowned push untouched: %j',
    async (payload) => {
      const s = setup()
      await s.invoke('push', { data: { json: () => payload } })
      expect(s.showNotification).not.toHaveBeenCalled()
      expect(s.fetch).not.toHaveBeenCalled()
    }
  )

  test.each([
    { link: '/another-provider' },
    { link: '/another-provider', delivery_id: 'other' },
    { link: '/another-provider', device_id: 'other' },
    { delivery_id: '', device_id: 'other' },
    { delivery_id: 42, device_id: 'other' },
    undefined,
  ])('a shared worker leaves an unowned click untouched: %j', async (data) => {
    const s = setup()
    const close = jest.fn()
    await s.invoke('notificationclick', { notification: { close, data } })
    expect(close).not.toHaveBeenCalled()
    expect(s.openWindow).not.toHaveBeenCalled()
    expect(s.fetch).not.toHaveBeenCalled()
  })

  test('a Customer.io test send without a link displays and opens the root on click', async () => {
    const s = setup()
    await s.invoke('push', {
      data: {
        json: () => ({
          body: 'Test message',
          'CIO-Delivery-ID': 'test-delivery',
          'CIO-Delivery-Token': 'endpoint',
        }),
      },
    })
    const close = jest.fn()
    await s.invoke('notificationclick', {
      notification: { close, data: s.showNotification.mock.calls[0][1].data },
    })
    expect(close).toHaveBeenCalled()
    expect(s.openWindow).toHaveBeenCalledWith('/')
    expect(
      s.fetch.mock.calls.map(([, options]) => JSON.parse(options.body).event)
    ).toEqual(['delivered', 'opened'])
  })
})

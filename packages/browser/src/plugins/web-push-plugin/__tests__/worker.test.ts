/** @jest-environment node */
import { createWorker, worker } from './worker-harness'

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(1700000000000))
afterEach(() => jest.restoreAllMocks())

// Fake only the worker's readiness timer: Node 19+ makes performance read-only,
// and the metric outbox's fake IndexedDB needs real immediates to settle.
const useClickTimers = () =>
  jest.useFakeTimers({
    doNotFake: ['performance', 'setImmediate', 'nextTick', 'queueMicrotask'],
  })

describe('cio-webpush-sw.js', () => {
  const setup = () => createWorker(worker)
  const relayMarkers = {
    'CIO-Delivery-ID': 'delivery',
    'CIO-Delivery-Token': 'endpoint',
  }
  const notificationMarkers = { delivery_id: 'delivery', device_id: 'endpoint' }

  test('keeps push alive after showing without delaying metrics or page messages', async () => {
    let finishNativeDelivery: () => void = () => {}
    const timer = jest.fn((resolve: () => void) => {
      finishNativeDelivery = resolve
    })
    const s = createWorker(worker, undefined, {}, undefined, {
      setTimeout: timer,
    })
    await s.startup
    let finishShowing: () => void = () => {}
    s.showNotification.mockImplementation(
      () => new Promise<void>((resolve) => (finishShowing = resolve))
    )
    let delivered: () => void = () => {}
    const reported = new Promise<void>((resolve) => (delivered = resolve))
    s.fetch.mockImplementation(() => {
      delivered()
      return Promise.resolve({ ok: true })
    })
    let finished = false
    const task = s
      .invoke('push', { data: { json: () => relayMarkers } })
      .then(() => {
        finished = true
      })
    expect(s.showNotification).toHaveBeenCalledTimes(1)
    expect(timer).not.toHaveBeenCalled()
    finishShowing()
    await reported
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 250)
    expect(s.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cio-webpush-received' })
    )
    expect(finished).toBe(false)
    finishNativeDelivery()
    await task
    expect(finished).toBe(true)
  })

  test.each([
    ['requireInteraction', true],
    ['requireInteraction', false],
    ['silent', true],
    ['silent', false],
    ['tag', 'order:123'],

    ['vibrate', [100, 0, 200]],
    ['lang', 'en-US'],
    ['dir', 'auto'],
    ['dir', 'ltr'],
    ['dir', 'rtl'],
    ['timestamp', 1700000000000],
    ['timestamp', 0],
  ])('passes %s = %j to showNotification', async (field, value) => {
    const s = setup()
    await s.invoke('push', {
      data: { json: () => ({ ...relayMarkers, [field as string]: value }) },
    })
    expect(s.showNotification.mock.calls[0][1][field as string]).toEqual(value)
  })

  test.each([1, 99999, 0])('sets or clears app_badge %i', async (count) => {
    const navigator = {
      setAppBadge: jest.fn().mockResolvedValue(undefined),
      clearAppBadge: jest.fn().mockResolvedValue(undefined),
    }
    const s = createWorker(worker, undefined, { navigator })
    await s.invoke('push', {
      data: { json: () => ({ ...relayMarkers, app_badge: count }) },
    })
    if (count === 0) {
      expect(navigator.clearAppBadge).toHaveBeenCalledTimes(1)
      expect(navigator.setAppBadge).not.toHaveBeenCalled()
    } else {
      expect(navigator.setAppBadge).toHaveBeenCalledWith(count)
      expect(navigator.clearAppBadge).not.toHaveBeenCalled()
    }
    expect(s.showNotification.mock.calls[0][1]).not.toHaveProperty('app_badge')
  })

  test.each([undefined, -1, 100000, 1.5, '5', null])(
    'does not badge for absent or invalid count %j',
    async (count) => {
      const navigator = { setAppBadge: jest.fn(), clearAppBadge: jest.fn() }
      const s = createWorker(worker, undefined, { navigator })
      await s.invoke('push', {
        data: { json: () => ({ ...relayMarkers, app_badge: count }) },
      })
      expect(navigator.setAppBadge).not.toHaveBeenCalled()
      expect(navigator.clearAppBadge).not.toHaveBeenCalled()
    }
  )

  test.each([
    {},
    {
      setAppBadge: jest.fn().mockRejectedValue(new Error('unsupported')),
      clearAppBadge: jest.fn().mockRejectedValue(new Error('unsupported')),
    },
  ])(
    'badge support and failures do not block delivery: %j',
    async (navigator) => {
      const s = createWorker(worker, undefined, { navigator })
      // Distinct deliveries: the durable outbox reports each delivery once.
      for (const count of [0, 3]) {
        await s.invoke('push', {
          data: {
            json: () => ({
              ...relayMarkers,
              'CIO-Delivery-ID': `delivery-${count}`,
              app_badge: count,
            }),
          },
        })
      }
      expect(s.showNotification).toHaveBeenCalledTimes(2)
      expect(s.fetch).toHaveBeenCalledTimes(2)
    }
  )

  test('push stores custom data and notifies controlled open clients', async () => {
    const s = setup()
    const custom_data = { orderId: '123', nested: { items: [1, 2] } }
    await s.invoke('push', {
      data: { json: () => ({ ...relayMarkers, custom_data }) },
    })
    expect(s.showNotification.mock.calls[0][1].data.custom_data).toEqual(
      custom_data
    )
    expect(s.clients.matchAll).toHaveBeenCalledWith({ type: 'window' })
    expect(s.postMessage).toHaveBeenCalledWith({
      type: 'cio-webpush-received',
      deliveryId: 'delivery',
      title: 'Customer.io',
      customData: custom_data,
    })
  })

  test.each(['existing', 'opened'])(
    'hands click to %s page once plugin is ready',
    async (kind) => {
      const s = setup()
      const custom_data = { orderId: '123' }
      const page = {
        id: 'page',
        url: 'https://example.com/orders/123',
        postMessage: jest.fn(),
      }
      s.clients.matchAll.mockResolvedValue(kind === 'existing' ? [page] : [])
      s.openWindow.mockResolvedValue(page)
      let finished = false
      const task = s
        .invoke('notificationclick', {
          action: 'view',
          notification: {
            close: jest.fn(),
            data: {
              ...notificationMarkers,
              custom_data,
              link: '/orders',
              actions: [{ action: 'view', url: page.url }],
            },
          },
        })
        .then(() => {
          finished = true
        })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(finished).toBe(false)
      expect(page.postMessage).toHaveBeenCalledWith({
        type: 'cio-webpush-check-ready',
      })
      await s.invoke('message', {
        source: { id: 'other', url: page.url },
        data: { type: 'cio-webpush-ready' },
      })
      expect(page.postMessage).toHaveBeenCalledTimes(1)
      await s.invoke('message', {
        source: page,
        data: { type: 'cio-webpush-ready' },
      })
      await task
      expect(page.postMessage).toHaveBeenLastCalledWith({
        type: 'cio-webpush-click',
        deliveryId: 'delivery',
        action: 'view',
        customData: custom_data,
      })
      expect(page.postMessage).toHaveBeenCalledTimes(2)
      expect(JSON.parse(s.fetch.mock.calls[0][1].body).event).toBe('opened')
    }
  )

  test('hands body clicks only to the returned client once, not matching tabs', async () => {
    const s = setup()
    const pages = ['a', 'b', 'other'].map((id) => ({
      id,
      url: `https://example.com/${id === 'other' ? 'private' : 'orders'}`,
      postMessage: jest.fn(),
    }))
    s.clients.matchAll.mockResolvedValue(pages)
    s.openWindow.mockResolvedValue(pages[0])
    const task = s.invoke('notificationclick', {
      action: '',
      notification: {
        close: jest.fn(),
        data: { ...notificationMarkers, link: '/orders' },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const page of pages)
      await s.invoke('message', {
        source: page,
        data: { type: 'cio-webpush-ready' },
      })
    await task
    await s.invoke('message', {
      source: pages[0],
      data: { type: 'cio-webpush-ready' },
    })
    expect(pages[0].postMessage).toHaveBeenLastCalledWith({
      type: 'cio-webpush-click',
      deliveryId: 'delivery',
      action: '',
      customData: undefined,
    })
    expect(pages[0].postMessage).toHaveBeenCalledTimes(2)
    expect(pages[1].postMessage).not.toHaveBeenCalled()
    expect(pages[2].postMessage).not.toHaveBeenCalled()
    expect(s.clients.matchAll).not.toHaveBeenCalled()
  })

  test('no accessible client still navigates and reports opened', async () => {
    const s = setup()
    s.clients.matchAll.mockResolvedValue([])
    s.openWindow.mockResolvedValue(null)
    await s.invoke('notificationclick', {
      notification: {
        close: jest.fn(),
        data: {
          ...notificationMarkers,
          link: 'https://other.example/orders',
          custom_data: { orderId: '123' },
        },
      },
    })
    expect(s.openWindow).toHaveBeenCalledWith('https://other.example/orders')
    expect(s.postMessage).not.toHaveBeenCalled()
    expect(JSON.parse(s.fetch.mock.calls[0][1].body).event).toBe('opened')
  })

  test('redirected and router-navigated clients receive clicks by id once', async () => {
    useClickTimers()
    try {
      const s = setup()
      const page = {
        id: 'page',
        url: 'https://example.com/redirected',
        postMessage: jest.fn(),
      }
      s.openWindow.mockResolvedValue(page)
      s.clients.matchAll.mockResolvedValue([])
      const task = s.invoke('notificationclick', {
        notification: {
          close: jest.fn(),
          data: { ...notificationMarkers, link: '/orders' },
        },
      })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(page.postMessage).toHaveBeenCalledTimes(1)
      await s.invoke('message', {
        source: { ...page, url: 'https://example.com/elsewhere' },
        data: { type: 'cio-webpush-ready' },
      })
      jest.advanceTimersByTime(10000)
      await task
      await s.invoke('message', {
        source: page,
        data: { type: 'cio-webpush-ready' },
      })
      expect(page.postMessage).toHaveBeenCalledTimes(2)
      expect(page.postMessage).toHaveBeenLastCalledWith({
        type: 'cio-webpush-click',
        deliveryId: 'delivery',
        action: '',
        customData: undefined,
      })
    } finally {
      jest.useRealTimers()
    }
  })

  test('readiness times out without delivering a late click', async () => {
    useClickTimers()
    try {
      const s = setup()
      const page = { id: 'page', postMessage: jest.fn() }
      s.openWindow.mockResolvedValue(page)
      const task = s.invoke('notificationclick', {
        notification: {
          close: jest.fn(),
          data: { ...notificationMarkers, link: '/orders' },
        },
      })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      jest.advanceTimersByTime(10000)
      await task
      await s.invoke('message', {
        source: page,
        data: { type: 'cio-webpush-ready' },
      })
      expect(page.postMessage).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test.each([
    [{ silent: true, vibrate: [100] }, { silent: true }],
    [{ renotify: true }, {}],
    [{ renotify: true, tag: '' }, { tag: '' }],
    [
      { renotify: true, tag: 'order' },
      { renotify: true, tag: 'order' },
    ],
    [{ dir: 'invalid' }, {}],
    [
      {
        silent: 0,
        requireInteraction: 1,
        tag: 123,
        lang: 42,
        timestamp: '100',
        vibrate: ['10', -1, 'bad'],
      },
      {
        silent: false,
        requireInteraction: true,
        tag: '123',
        lang: '42',
        timestamp: 100,
        vibrate: [10],
      },
    ],
    [{ timestamp: 'invalid' }, {}],
    [{ tag: { toString: 0 } }, {}],
    [{ vibrate: [{ toString: 0, valueOf: 0 }] }, {}],
  ])('sanitizes notification options %j', async (input, expected) => {
    const s = setup()
    s.showNotification.mockImplementation(async (_title, options) => {
      if (
        (options.silent && options.vibrate !== undefined) ||
        (options.renotify && !options.tag) ||
        (options.dir !== undefined &&
          !['auto', 'ltr', 'rtl'].includes(options.dir))
      )
        throw new TypeError('invalid options')
    })
    await s.invoke('push', {
      data: { json: () => ({ ...relayMarkers, ...input }) },
    })
    const options = s.showNotification.mock.calls[0][1]
    const advanced = Object.fromEntries(
      Object.entries(options).filter(([key]) =>
        [
          'silent',
          'vibrate',
          'renotify',
          'tag',
          'dir',
          'lang',
          'timestamp',
          'requireInteraction',
        ].includes(key)
      )
    )
    expect(advanced).toEqual(expected)
    expect(s.fetch).toHaveBeenCalledTimes(1)
  })

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
          custom_data: { orderId: '123' },
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
        custom_data: { orderId: '123' },
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

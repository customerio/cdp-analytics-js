import fs from 'fs'
import path from 'path'
import vm from 'vm'

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(1700000000000))
afterEach(() => jest.restoreAllMocks())

function setup() {
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
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../cio-webpush-sw.js'), 'utf8'),
    { self, fetch, URL, Date, console: { warn: jest.fn() } }
  )
  const invoke = (name: string, event: any) => {
    let task: Promise<unknown> = Promise.resolve()
    listeners[name]({
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

test('push shows the notification, then sends a text-body delivered metric', async () => {
  const s = setup()
  await s.invoke('push', {
    data: {
      json: () => ({
        title: 'Title',
        body: 'Body',
        image: '/image.png',
        link: '/destination',
        'CIO-Delivery-ID': 'delivery',
        'CIO-Delivery-Token': 'endpoint',
      }),
    },
  })
  expect(s.showNotification).toHaveBeenCalledWith('Title', {
    body: 'Body',
    image: '/image.png',
    data: {
      link: '/destination',
      delivery_id: 'delivery',
      device_id: 'endpoint',
    },
  })
  expect(s.fetch).toHaveBeenCalledWith(
    'https://track.customer.io/push/events',
    {
      method: 'POST',
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

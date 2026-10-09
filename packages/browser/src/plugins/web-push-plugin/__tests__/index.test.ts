import { Analytics } from '../../../core/analytics'
import { Context } from '../../../core/context'
import { WebPushPlugin } from '..'

const key = btoa(String.fromCharCode(4) + 'a'.repeat(64))
const value = {
  endpoint: 'https://push.example/device',
  keys: { p256dh: 'p256dh', auth: 'auth' },
}

function setup(userId: string | null = 'person') {
  let id = userId
  const listeners: Record<string, (...args: any[]) => void> = {}
  const subscription = {
    endpoint: value.endpoint,
    toJSON: () => value,
    unsubscribe: jest.fn().mockResolvedValue(true),
  }
  const manager = {
    getSubscription: jest.fn().mockResolvedValue(null),
    subscribe: jest.fn().mockResolvedValue(subscription),
  }
  const registration: {
    active: { state: string; scriptURL: string } | null
    pushManager: typeof manager
  } = {
    active: {
      state: 'activated',
      scriptURL: 'http://localhost/cio-webpush-sw.js',
    },
    pushManager: manager,
  }
  const sw = {
    register: jest.fn().mockResolvedValue(registration),
    getRegistration: jest.fn().mockResolvedValue(registration),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: sw,
  })
  Object.defineProperty(window, 'PushManager', {
    configurable: true,
    value: function () {},
  })
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: { requestPermission: jest.fn().mockResolvedValue('granted') },
  })
  const analytics = {
    user: () => ({ id: () => id }),
    track: jest.fn().mockResolvedValue({}),
    on: jest.fn((event, listener) => {
      listeners[event] = listener
    }),
    off: jest.fn(),
  } as unknown as Analytics
  const plugin = WebPushPlugin({ vapidPublicKey: key })
  const load = () => plugin.load(Context.system(), analytics)
  const identify = () => {
    id = 'person'
    listeners.identify()
  }
  return {
    analytics,
    plugin,
    load,
    identify,
    manager,
    registration,
    sw,
    subscription,
  }
}

beforeEach(() => localStorage.clear())

test('reuses a compatible subscription when the browser does not expose its key', async () => {
  const s = setup()
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  await s.load()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const track = jest.mocked(s.analytics.track)
  const before = track.mock.calls.length

  await expect(s.analytics.webPush!.subscribe()).resolves.toEqual(value)

  expect(s.subscription.unsubscribe).not.toHaveBeenCalled()
  expect(s.manager.subscribe).toHaveBeenCalledTimes(1)
  expect(track.mock.calls.slice(before).map(([event]) => event)).toEqual([
    'Device Created or Updated',
  ])
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('rotates an unexposed key only after the active browser reports a mismatch', async () => {
  const s = setup()
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  await s.load()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const track = jest.mocked(s.analytics.track)
  const before = track.mock.calls.length
  s.manager.subscribe.mockRejectedValueOnce(
    new DOMException('different key', 'InvalidStateError')
  )

  await expect(s.analytics.webPush!.subscribe()).resolves.toEqual(value)

  expect(s.subscription.unsubscribe).toHaveBeenCalledTimes(1)
  expect(s.manager.subscribe).toHaveBeenCalledTimes(2)
  expect(s.manager.subscribe.mock.invocationCallOrder[0]).toBeLessThan(
    s.subscription.unsubscribe.mock.invocationCallOrder[0]
  )
  expect(track.mock.calls.slice(before).map(([event]) => event)).toEqual([
    'Device Deleted',
    'Device Created or Updated',
  ])
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('keeps the subscription and owner when the worker disappears during subscribe', async () => {
  const s = setup()
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  await s.load()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const track = jest.mocked(s.analytics.track)
  const before = track.mock.calls.length
  const owner = localStorage.getItem('cio-webpush:/cio-webpush-sw.js')
  const error = new DOMException('no worker', 'InvalidStateError')
  s.manager.subscribe.mockImplementationOnce(async () => {
    s.registration.active = null
    throw error
  })

  await expect(s.analytics.webPush!.subscribe()).rejects.toBe(error)

  expect(s.subscription.unsubscribe).not.toHaveBeenCalled()
  expect(s.manager.subscribe).toHaveBeenCalledTimes(1)
  expect(track.mock.calls.slice(before)).toEqual([])
  expect(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')).toBe(owner)
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('does not retry InvalidStateError without an existing subscription', async () => {
  const s = setup()
  const error = new DOMException('no worker', 'InvalidStateError')
  s.manager.subscribe.mockRejectedValueOnce(error)
  await s.load()

  await expect(s.analytics.webPush!.subscribe()).rejects.toBe(error)

  expect(s.manager.subscribe).toHaveBeenCalledTimes(1)
  expect(s.subscription.unsubscribe).not.toHaveBeenCalled()
  expect(s.analytics.track).not.toHaveBeenCalled()
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test.each(['AbortError', 'NotAllowedError'])(
  'keeps the subscription and owner when subscribe rejects with %s',
  async (name) => {
    const s = setup()
    s.manager.getSubscription.mockResolvedValue(s.subscription)
    await s.load()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const track = jest.mocked(s.analytics.track)
    const before = track.mock.calls.length
    const owner = localStorage.getItem('cio-webpush:/cio-webpush-sw.js')
    const error = new DOMException('subscribe failed', name)
    s.manager.subscribe.mockRejectedValueOnce(error)

    await expect(s.analytics.webPush!.subscribe()).rejects.toBe(error)

    expect(s.manager.subscribe).toHaveBeenCalledTimes(1)
    expect(s.subscription.unsubscribe).not.toHaveBeenCalled()
    expect(track.mock.calls.slice(before)).toEqual([])
    expect(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')).toBe(owner)
    await s.plugin.unload?.(Context.system(), s.analytics)
  }
)

test('rotates a known different key before subscribing', async () => {
  const s = setup()
  s.manager.getSubscription.mockResolvedValue({
    ...s.subscription,
    options: {
      applicationServerKey: Uint8Array.from([4, ...Array(64).fill(98)]).buffer,
    },
  })
  await s.load()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const track = jest.mocked(s.analytics.track)
  const before = track.mock.calls.length

  await expect(s.analytics.webPush!.subscribe()).resolves.toEqual(value)

  expect(s.subscription.unsubscribe).toHaveBeenCalledTimes(1)
  expect(s.manager.subscribe).toHaveBeenCalledTimes(1)
  expect(s.subscription.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(
    s.manager.subscribe.mock.invocationCallOrder[0]
  )
  expect(track.mock.calls.slice(before).map(([event]) => event)).toEqual([
    'Device Deleted',
    'Device Created or Updated',
  ])
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('reuses a subscription with the requested exposed key', async () => {
  const s = setup()
  s.manager.getSubscription.mockResolvedValue({
    ...s.subscription,
    options: {
      applicationServerKey: Uint8Array.from([4, ...Array(64).fill(97)]).buffer,
    },
  })
  await s.load()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const track = jest.mocked(s.analytics.track)
  const before = track.mock.calls.length

  await expect(s.analytics.webPush!.subscribe()).resolves.toEqual(value)

  expect(s.subscription.unsubscribe).not.toHaveBeenCalled()
  expect(s.manager.subscribe).toHaveBeenCalledTimes(1)
  expect(track.mock.calls.slice(before).map(([event]) => event)).toEqual([
    'Device Created or Updated',
  ])
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('keeps the owner when fallback browser unsubscribe fails', async () => {
  const s = setup()
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  await s.load()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const track = jest.mocked(s.analytics.track)
  const before = track.mock.calls.length
  const owner = localStorage.getItem('cio-webpush:/cio-webpush-sw.js')
  s.manager.subscribe.mockRejectedValueOnce(
    new DOMException('different key', 'InvalidStateError')
  )
  s.subscription.unsubscribe.mockResolvedValueOnce(false)

  await expect(s.analytics.webPush!.subscribe()).rejects.toThrow(
    'Browser unsubscribe failed.'
  )

  expect(s.manager.subscribe).toHaveBeenCalledTimes(1)
  expect(s.subscription.unsubscribe).toHaveBeenCalledTimes(1)
  expect(track.mock.calls.slice(before)).toEqual([])
  expect(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')).toBe(owner)
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('loading is inert, including when explicitly disabled', async () => {
  const s = setup()
  await s.load()
  expect(s.sw.register).not.toHaveBeenCalled()
  expect(s.manager.subscribe).not.toHaveBeenCalled()
  expect(s.analytics.track).not.toHaveBeenCalled()
  expect(Notification.requestPermission).not.toHaveBeenCalled()
  await s.plugin.unload?.(Context.system(), s.analytics)
  const disabled = WebPushPlugin({ vapidPublicKey: key, enabled: false })
  await disabled.load(Context.system(), s.analytics)
  expect(s.analytics.webPush).toBeUndefined()
})

test('subscribes with the VAPID key and exact Pipelines device event', async () => {
  const s = setup()
  await s.load()
  expect(await s.analytics.webPush!.subscribe()).toEqual(value)
  expect(s.sw.register).toHaveBeenCalledWith(
    '/cio-webpush-sw.js?track=https%3A%2F%2Ftrack.customer.io'
  )
  expect(s.manager.subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: new Uint8Array([4, ...Array(64).fill(97)]),
  })
  expect(s.analytics.track).toHaveBeenCalledWith(
    'Device Created or Updated',
    {
      webpush_p256dh: 'p256dh',
      webpush_auth: 'auth',
      user_agent: navigator.userAgent,
    },
    {
      userId: 'person',
      context: { device: { token: value.endpoint, type: 'web' } },
    }
  )
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('queues anonymous subscription until identify', async () => {
  const s = setup(null)
  await s.load()
  const result = s.analytics.webPush!.subscribe()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(s.analytics.track).not.toHaveBeenCalled()
  s.identify()
  expect(await result).toEqual(value)
  expect(s.analytics.track).toHaveBeenCalledTimes(1)
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('rejects anonymous operations when the page lifetime ends', async () => {
  const s = setup(null)
  await s.load()
  const result = s.analytics.webPush!.subscribe()
  const rejected = expect(result).rejects.toThrow('analytics.identify(userId)')
  await new Promise((resolve) => setTimeout(resolve, 0))
  window.dispatchEvent(new Event('pagehide'))
  await rejected
  expect(s.analytics.track).not.toHaveBeenCalled()
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('returns the live subscription and unsubscribes before tracking deletion', async () => {
  const s = setup()
  localStorage.setItem(
    'cio-webpush:/cio-webpush-sw.js',
    JSON.stringify({ endpoint: value.endpoint, userId: 'person' })
  )
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  await s.load()
  expect(await s.analytics.webPush!.subscription()).toEqual(value)
  await s.analytics.webPush!.unsubscribe()
  expect(s.subscription.unsubscribe).toHaveBeenCalled()
  expect(s.analytics.track).toHaveBeenCalledWith(
    'Device Deleted',
    {},
    {
      userId: 'person',
      context: { device: { token: value.endpoint, type: 'web' } },
    }
  )
  expect(s.subscription.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(
    (s.analytics.track as jest.Mock).mock.invocationCallOrder[0]
  )
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('keeps the deleted endpoint for retry when tracking fails', async () => {
  const s = setup()
  localStorage.setItem(
    'cio-webpush:/cio-webpush-sw.js',
    JSON.stringify({ endpoint: value.endpoint, userId: 'person' })
  )
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  await s.load()
  ;(s.analytics.track as jest.Mock).mockRejectedValueOnce(new Error('offline'))
  await expect(s.analytics.webPush!.unsubscribe()).rejects.toThrow('offline')
  expect(
    JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
  ).toEqual({ endpoint: value.endpoint, userId: 'person' })
  s.manager.getSubscription.mockResolvedValue(null)
  await s.analytics.webPush!.unsubscribe()
  expect(s.analytics.track).toHaveBeenLastCalledWith(
    'Device Deleted',
    {},
    {
      userId: 'person',
      context: { device: { token: value.endpoint, type: 'web' } },
    }
  )
  expect(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')).toBeNull()
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('resends a changed endpoint on load and on worker messages', async () => {
  const s = setup()
  localStorage.setItem('cio-webpush:/cio-webpush-sw.js', 'old-endpoint')
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  await s.load()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(s.analytics.track).toHaveBeenCalledTimes(1)
  const listener = s.sw.addEventListener.mock.calls[0][1]
  listener({ data: { type: 'cio-webpush-subscriptionchange' } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(s.analytics.track).toHaveBeenCalledTimes(2)
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('permission denial and unsupported browsers never register a worker', async () => {
  const s = setup()
  await s.load()
  ;(Notification.requestPermission as jest.Mock).mockResolvedValue('denied')
  await expect(s.analytics.webPush!.subscribe()).rejects.toThrow('not granted')
  expect(s.sw.register).not.toHaveBeenCalled()
  delete (window as any).PushManager
  await expect(s.analytics.webPush!.subscribe()).rejects.toThrow(
    'supported browser'
  )
  await s.plugin.unload?.(Context.system(), s.analytics)
})

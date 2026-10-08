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
  const registration = {
    scope: 'http://localhost/',
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
  return { analytics, plugin, load, identify, manager, sw, subscription }
}

beforeEach(() => localStorage.clear())

test('does not replace an unrelated worker at the requested scope', async () => {
  const s = setup()
  s.sw.getRegistration.mockResolvedValue({
    scope: 'http://localhost/',
    active: {
      state: 'activated',
      scriptURL: 'http://localhost/host-worker.js',
    },
    pushManager: s.manager,
  })
  await s.load()
  await expect(s.analytics.webPush!.subscribe()).rejects.toThrow(
    'existing service worker'
  )
  expect(s.sw.register).not.toHaveBeenCalled()
  expect(s.manager.subscribe).not.toHaveBeenCalled()
  expect(s.analytics.track).not.toHaveBeenCalled()
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('allows a dedicated scope beneath an unrelated root worker', async () => {
  const s = setup()
  s.sw.getRegistration.mockResolvedValue({
    scope: 'http://localhost/',
    active: {
      state: 'activated',
      scriptURL: 'http://localhost/host-worker.js',
    },
    pushManager: s.manager,
  })
  await s.load()
  await expect(
    s.analytics.webPush!.subscribe({
      serviceWorkerUrl: '/notifications/cio-webpush-sw.js',
    })
  ).resolves.toEqual(value)
  expect(s.sw.register).toHaveBeenCalledWith(
    '/notifications/cio-webpush-sw.js?track=https%3A%2F%2Ftrack.customer.io'
  )
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('allows explicit integration with the existing worker', async () => {
  const s = setup()
  s.sw.getRegistration.mockResolvedValue({
    scope: 'http://localhost/',
    active: {
      state: 'activated',
      scriptURL: 'http://localhost/host-worker.js',
    },
    pushManager: s.manager,
  })
  await s.load()
  await expect(
    s.analytics.webPush!.subscribe({ serviceWorkerUrl: '/host-worker.js' })
  ).resolves.toEqual(value)
  expect(s.sw.register).toHaveBeenCalledWith(
    '/host-worker.js?track=https%3A%2F%2Ftrack.customer.io'
  )
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('a failed worker path change preserves the live subscription lookup', async () => {
  const s = setup()
  localStorage.setItem(
    'cio-webpush:/cio-webpush-sw.js',
    JSON.stringify({ endpoint: value.endpoint, userId: 'person' })
  )
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  await s.load()
  s.sw.register.mockRejectedValueOnce(new Error('worker fetch failed'))
  await expect(
    s.analytics.webPush!.subscribe({
      serviceWorkerUrl: '/notifications/cio-webpush-sw.js',
    })
  ).rejects.toThrow('worker fetch failed')
  expect(await s.analytics.webPush!.subscription()).toEqual(value)
  await s.analytics.webPush!.unsubscribe()
  expect(s.subscription.unsubscribe).toHaveBeenCalledTimes(1)
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

test('finishes the first subscription after permission changes from default to granted', async () => {
  const s = setup()
  let permission: NotificationPermission = 'default'
  let allow!: () => void
  // Reuse setup's Notification object; a second window.Notification
  // redefinition is not observed under Node14/jsdom.
  const requestPermission = Notification.requestPermission as jest.Mock
  requestPermission.mockImplementationOnce(
    () =>
      new Promise<NotificationPermission>((resolve) => {
        allow = () => {
          permission = 'granted'
          resolve(permission)
        }
      })
  )
  Object.defineProperty(Notification, 'permission', {
    configurable: true,
    get: () => permission,
  })
  s.manager.subscribe.mockImplementation(async () => {
    if (Notification.permission !== 'granted')
      throw new Error('Push subscription requires granted permission.')
    return s.subscription
  })
  await s.load()

  const firstAttempt = s.analytics.webPush!.subscribe()
  // Mark a premature rejection as handled so the intended assertion reports it.
  void firstAttempt.catch(() => {})
  // The native prompt must start synchronously inside the user gesture.
  expect(requestPermission).toHaveBeenCalledTimes(1)
  // Let the immediate fake browser calls settle while permission is pending.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(Notification.permission).toBe('default')
  expect(s.sw.register).not.toHaveBeenCalled()
  expect(s.manager.subscribe).not.toHaveBeenCalled()
  expect(s.analytics.track).not.toHaveBeenCalled()

  allow()

  await expect(firstAttempt).resolves.toEqual(value)
  expect(requestPermission).toHaveBeenCalledTimes(1)
  expect(s.manager.subscribe).toHaveBeenCalledTimes(1)
  expect(s.analytics.track).toHaveBeenCalledTimes(1)
  expect(s.analytics.track).toHaveBeenCalledWith(
    'Device Created or Updated',
    expect.objectContaining({ webpush_p256dh: 'p256dh', webpush_auth: 'auth' }),
    {
      userId: 'person',
      context: { device: { token: value.endpoint, type: 'web' } },
    }
  )
  Reflect.deleteProperty(Notification, 'permission')
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

test('keeps a previous owner at the new worker path when deletion fails', async () => {
  const s = setup()
  localStorage.setItem(
    'cio-webpush:/cio-webpush-sw.js',
    JSON.stringify({
      endpoint: 'https://push.example/previous',
      userId: 'person',
    })
  )
  await s.load()
  ;(s.analytics.track as jest.Mock).mockRejectedValueOnce(new Error('offline'))
  await expect(
    s.analytics.webPush!.subscribe({
      serviceWorkerUrl: '/notifications/cio-webpush-sw.js',
    })
  ).rejects.toThrow('offline')
  expect(
    JSON.parse(
      localStorage.getItem('cio-webpush:/notifications/cio-webpush-sw.js')!
    )
  ).toEqual({ endpoint: 'https://push.example/previous', userId: 'person' })
  await s.plugin.unload?.(Context.system(), s.analytics)

  const reloaded = setup()
  await reloaded.load()
  await reloaded.analytics.webPush!.subscribe()
  expect(
    (reloaded.analytics.track as jest.Mock).mock.calls.map(([event]) => event)
  ).toEqual(['Device Deleted', 'Device Created or Updated'])
  await reloaded.plugin.unload?.(Context.system(), reloaded.analytics)
})

test('a worker path change never overwrites an existing destination owner', async () => {
  const s = setup()
  localStorage.setItem(
    'cio-webpush:/cio-webpush-sw.js',
    JSON.stringify({
      endpoint: 'https://push.example/previous',
      userId: 'person',
    })
  )
  const destination = JSON.stringify({
    endpoint: 'https://push.example/other',
    userId: 'other',
  })
  localStorage.setItem(
    'cio-webpush:/notifications/cio-webpush-sw.js',
    destination
  )
  await s.load()
  s.manager.subscribe.mockRejectedValueOnce(
    new Error('push service unavailable')
  )
  await expect(
    s.analytics.webPush!.subscribe({
      serviceWorkerUrl: '/notifications/cio-webpush-sw.js',
    })
  ).rejects.toThrow('push service unavailable')
  expect(
    localStorage.getItem('cio-webpush:/notifications/cio-webpush-sw.js')
  ).toBe(destination)
  expect(s.analytics.track).not.toHaveBeenCalled()
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

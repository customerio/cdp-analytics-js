import { Analytics } from '../../../core/analytics'
import { Context } from '../../../core/context'
import { WebPushPlugin, WebPushPluginSettings } from '..'
import { acceptDevice } from '../../customerio/device-delivery'
import { deviceAttributes } from '../device-attributes'

const key = btoa(String.fromCharCode(4) + 'a'.repeat(64))
const value = {
  endpoint: 'https://push.example/device',
  keys: { p256dh: 'p256dh', auth: 'auth' },
}

// Defined once: Node 14 does not rebind a redefined global for loaded modules.
const preflightFetch = jest.fn()
Object.defineProperty(window, 'fetch', {
  configurable: true,
  value: preflightFetch,
})

function setup(
  userId: string | null = 'person',
  settings: Partial<WebPushPluginSettings> = {}
) {
  let id = userId
  const listeners: Record<string, (...args: any[]) => void> = {}
  const subscription = {
    expirationTime: null as number | null,
    endpoint: value.endpoint,
    toJSON: () => value,
    unsubscribe: jest.fn().mockResolvedValue(true),
  }
  const manager = {
    getSubscription: jest.fn().mockResolvedValue(null),
    subscribe: jest.fn().mockResolvedValue(subscription),
  }
  const registration: {
    scope: string
    active: { state: string; scriptURL: string } | null
    pushManager: typeof manager
  } = {
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
  // Runtime preflight: any response means the runtime host answers.
  const fetch = preflightFetch.mockReset().mockResolvedValue({})
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
    track: jest.fn().mockImplementation(async () => {
      const ctx = Context.system()
      acceptDevice(ctx)
      return ctx
    }),
    on: jest.fn((event, listener) => {
      listeners[event] = listener
    }),
    off: jest.fn(),
  } as unknown as Analytics
  const plugin = WebPushPlugin({ vapidPublicKey: key, ...settings })
  const load = () => plugin.load(Context.system(), analytics)
  const identify = (nextId = 'person') => {
    id = nextId
    listeners.identify()
  }
  const reset = () => {
    id = null
    listeners.reset()
  }
  return {
    analytics,
    plugin,
    load,
    identify,
    reset,
    manager,
    registration,
    sw,
    subscription,
    fetch,
  }
}

beforeEach(() => localStorage.clear())

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const record = () =>
  JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)

test('retains anonymous subscribe through a bfcache freeze and identifies on return', async () => {
  const s = setup(null)
  await s.load()
  const result = s.analytics.webPush!.subscribe()
  await settle()
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  await settle()
  expect(s.analytics.track).not.toHaveBeenCalled()
  s.identify()
  await expect(result).resolves.toEqual(value)
  expect(s.analytics.track).toHaveBeenCalledTimes(1)
  expect(record().userId).toBe('person')
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('identify reattaches a live subscription without any saved registration', async () => {
  const s = setup(null)
  await s.load()
  await settle()
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  s.identify()
  await settle()
  expect(s.analytics.track).toHaveBeenCalledTimes(1)
  expect(record().userId).toBe('person')
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test.each(['identify', 'pageshow', 'reload', 'subscribe'])(
  'unaccepted registration remains retryable on %s',
  async (trigger) => {
    const s = setup()
    await s.load()
    jest.mocked(s.analytics.track).mockResolvedValueOnce(Context.system())
    await expect(s.analytics.webPush!.subscribe()).rejects.toThrow(
      'not accepted'
    )
    expect(record()).toEqual({
      endpoint: value.endpoint,
      userId: 'person',
      registered: false,
      pendingCreate: {
        webpush_event_ms: expect.any(Number),
        webpush_seq: expect.any(Number),
      },
    })
    s.manager.getSubscription.mockResolvedValue(s.subscription)
    if (trigger === 'reload') {
      await s.plugin.unload?.(Context.system(), s.analytics)
      await s.load()
    } else if (trigger === 'identify') s.identify()
    else if (trigger === 'pageshow')
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true })
      )
    else await s.analytics.webPush!.subscribe()
    await settle()
    expect(record()).toEqual({
      endpoint: value.endpoint,
      userId: 'person',
      attributesFingerprint: expect.any(String),
    })
    expect(s.analytics.track).toHaveBeenCalledTimes(2)
    const calls = jest.mocked(s.analytics.track).mock.calls
    expect(calls[1][2]).toEqual(calls[0][2])
    await s.plugin.unload?.(Context.system(), s.analytics)
  }
)

test('a rejected forced registration invalidates a previously matching record', async () => {
  const s = setup()
  await s.load()
  await s.analytics.webPush!.subscribe()
  jest.mocked(s.analytics.track).mockRejectedValueOnce(new Error('network'))
  await expect(s.analytics.webPush!.subscribe()).rejects.toThrow('network')
  expect(record().registered).toBe(false)
  await s.analytics.webPush!.subscribe()
  expect(record().registered).toBeUndefined()
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('device events carry original wall-clock time without future-dating same-second operations', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1700000000000)
  const s = setup()
  await s.load()
  await s.analytics.webPush!.subscribe()
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  s.reset()
  s.identify()
  await settle()
  const calls = jest.mocked(s.analytics.track).mock.calls
  expect(calls.map(([event]) => event)).toEqual([
    'Device Created or Updated',
    'Device Deleted',
    'Device Created or Updated',
  ])
  const times = calls.map(([, , options]) =>
    Number(typeof options === 'object' ? options?.timestamp : undefined)
  )
  expect(times).toEqual([1700000000000, 1700000000000, 1700000000000])
  expect(
    calls.map(([, , options]) => (options as any).context.device.webpush_seq)
  ).toEqual([1700000000000, 1700000000001, 1700000000002])
  await s.plugin.unload?.(Context.system(), s.analytics)
  now.mockReturnValue(1700000002000)
  await s.load()
  await s.analytics.webPush!.subscribe()
  const options = jest.mocked(s.analytics.track).mock.calls[3][2]
  expect(
    Number(typeof options === 'object' ? options?.timestamp : undefined)
  ).toBe(1700000002000)
  expect((options as any).context.device.webpush_seq).toBe(1700000002000)
  now.mockRestore()
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test.each([null, 1800000000123, 0])(
  'all device registration paths include parsed attributes and expiry %j',
  async (expirationTime) => {
    const s = setup()
    s.subscription.expirationTime = expirationTime
    const ua = jest
      .spyOn(navigator, 'userAgent', 'get')
      .mockReturnValue(
        'Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0'
      )
    try {
      // Initial subscribe, explicit update, reload reconciliation and
      // subscription-change all use the same device registration path.
      await s.load()
      await s.analytics.webPush!.subscribe()
      await s.analytics.webPush!.subscribe()
      s.manager.getSubscription.mockResolvedValue(s.subscription)
      s.sw.addEventListener.mock.calls[0][1]({
        data: { type: 'cio-webpush-subscriptionchange' },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const properties = jest
        .mocked(s.analytics.track)
        .mock.calls.filter(([event]) => event === 'Device Created or Updated')
        .map(([, props]) => props)
      expect(properties).toHaveLength(3)
      for (const props of properties) {
        expect(props).toEqual({
          webpush_p256dh: value.keys.p256dh,
          webpush_auth: value.keys.auth,
          user_agent: navigator.userAgent,
          browser: 'Firefox',
          browser_version: '157',
          os: 'Linux',
          origin: 'http://localhost',
          webpush_expiration_time: expirationTime,
        })
      }
      await s.plugin.unload?.(Context.system(), s.analytics)
      // A fresh plugin reload with no stored owner registers the same metadata.
      localStorage.clear()
      const reloaded = setup()
      reloaded.subscription.expirationTime = expirationTime
      reloaded.manager.getSubscription.mockResolvedValue(reloaded.subscription)
      await reloaded.load()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(jest.mocked(reloaded.analytics.track).mock.calls[0][1]).toEqual(
        properties[0]
      )
      await reloaded.plugin.unload?.(Context.system(), reloaded.analytics)
    } finally {
      ua.mockRestore()
    }
  }
)

test('registration prefers navigator.userAgentData without requesting high-entropy hints', async () => {
  const s = setup()
  Object.defineProperty(navigator, 'userAgentData', {
    configurable: true,
    value: {
      brands: [{ brand: 'Microsoft Edge', version: '154' }],
      platform: 'Windows',
    },
  })
  try {
    await s.load()
    await s.analytics.webPush!.subscribe()
    expect(jest.mocked(s.analytics.track).mock.calls[0][1]).toMatchObject({
      browser: 'Edge',
      browser_version: '154',
      os: 'Windows',
    })
    await s.plugin.unload?.(Context.system(), s.analytics)
  } finally {
    Reflect.deleteProperty(navigator, 'userAgentData')
  }
})

test('click messages dispatch typed CustomEvents and removable onClick callbacks', async () => {
  const s = setup()
  await s.load()
  const listener = s.sw.addEventListener.mock.calls.find(
    ([name]) => name === 'message'
  )![1]
  const callback = jest.fn()
  const other = jest.fn()
  const eventListener = jest.fn()
  window.addEventListener('cio:webpush:click', eventListener)
  const remove = s.analytics.webPush!.onClick(callback)
  s.analytics.webPush!.onClick(other)
  const detail = {
    type: 'cio-webpush-click',
    deliveryId: 'delivery',
    action: 'view',
    customData: { orderId: '123', nested: { items: [1, 2] } },
  }
  listener({ data: detail })
  const { type: _type, ...publicDetail } = detail
  expect(callback).toHaveBeenCalledWith(publicDetail)
  expect(other).toHaveBeenCalledWith(publicDetail)
  expect(eventListener.mock.calls[0][0].detail).toEqual(publicDetail)
  remove()
  listener({ data: { ...detail, action: '', customData: undefined } })
  expect(callback).toHaveBeenCalledTimes(1)
  expect(other).toHaveBeenLastCalledWith({
    ...publicDetail,
    action: '',
    customData: undefined,
  })
  await s.plugin.unload?.(Context.system(), s.analytics)
  expect(s.sw.removeEventListener).toHaveBeenCalledWith('message', listener)
  listener({ data: detail })
  expect(other).toHaveBeenCalledTimes(2)
  window.removeEventListener('cio:webpush:click', eventListener)
})

test('a failing click callback does not prevent other callbacks', async () => {
  const s = setup()
  await s.load()
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  const callback = jest.fn()
  s.analytics.webPush!.onClick(() => {
    throw new Error('app callback')
  })
  s.analytics.webPush!.onClick(callback)
  const listener = s.sw.addEventListener.mock.calls[0][1]
  listener({
    data: { type: 'cio-webpush-click', deliveryId: 'delivery', action: '' },
  })
  expect(callback).toHaveBeenCalledTimes(1)
  warn.mockRestore()
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('plugin announces readiness on load, controller changes, and worker probes', async () => {
  const s = setup()
  const controller = { postMessage: jest.fn() }
  Object.assign(s.sw, { controller })
  await s.load()
  expect(controller.postMessage).toHaveBeenCalledWith({
    type: 'cio-webpush-ready',
  })
  const changed = s.sw.addEventListener.mock.calls.find(
    ([name]) => name === 'controllerchange'
  )![1]
  changed()
  expect(controller.postMessage).toHaveBeenCalledTimes(2)
  const source = { postMessage: jest.fn() }
  const listener = s.sw.addEventListener.mock.calls[0][1]
  listener({ data: { type: 'cio-webpush-check-ready' }, source })
  expect(source.postMessage).toHaveBeenCalledWith({ type: 'cio-webpush-ready' })
  await s.plugin.unload?.(Context.system(), s.analytics)
  expect(s.sw.removeEventListener).toHaveBeenCalledWith(
    'controllerchange',
    changed
  )
})

test('received messages dispatch to window without invoking click callbacks', async () => {
  const s = setup()
  await s.load()
  const callback = jest.fn()
  s.analytics.webPush!.onClick(callback)
  const eventListener = jest.fn()
  window.addEventListener('cio:webpush:received', eventListener)
  const detail = {
    type: 'cio-webpush-received',
    deliveryId: 'delivery',
    title: 'Order ready',
    customData: { orderId: '123' },
    privateField: 'not public',
  }
  s.sw.addEventListener.mock.calls[0][1]({ data: detail })
  expect(eventListener.mock.calls[0][0].detail).toEqual({
    deliveryId: 'delivery',
    title: 'Order ready',
    customData: { orderId: '123' },
  })
  expect(callback).not.toHaveBeenCalled()
  window.removeEventListener('cio:webpush:received', eventListener)
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test.each([
  null,
  {},
  { type: 'unknown' },
  { type: 'cio-webpush-click', deliveryId: 1, action: '' },
  { type: 'cio-webpush-click', deliveryId: 'delivery' },
])('ignores unrelated or malformed click messages: %j', async (data) => {
  const s = setup()
  await s.load()
  const callback = jest.fn()
  s.analytics.webPush!.onClick(callback)
  s.sw.addEventListener.mock.calls[0][1]({ data })
  expect(callback).not.toHaveBeenCalled()
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test.each([null, [], 'bad', 123, new Date()])(
  'malformed custom data %j is omitted without dropping clicks; logs once',
  async (customData) => {
    const s = setup()
    await s.load()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const callback = jest.fn()
      s.analytics.webPush!.onClick(callback)
      const listener = s.sw.addEventListener.mock.calls[0][1]
      for (let i = 0; i < 2; i++)
        listener({
          data: {
            type: 'cio-webpush-click',
            deliveryId: 'delivery',
            action: '',
            customData,
          },
        })
      expect(callback).toHaveBeenCalledTimes(2)
      expect(callback).toHaveBeenLastCalledWith({
        deliveryId: 'delivery',
        action: '',
        customData: undefined,
      })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
      await s.plugin.unload?.(Context.system(), s.analytics)
    }
  }
)

test('reset suppresses in-flight handoffs even after registering again', async () => {
  const s = setup()
  await s.load()
  await s.analytics.webPush!.subscribe()
  const callback = jest.fn()
  s.analytics.webPush!.onClick(callback)
  s.reset()
  s.identify()
  await s.analytics.webPush!.subscribe()
  const received = jest.fn()
  window.addEventListener('cio:webpush:received', received)
  const listener = s.sw.addEventListener.mock.calls[0][1]
  listener({
    data: {
      type: 'cio-webpush-click',
      deliveryId: 'delivery',
      action: '',
      customData: { secret: true },
    },
  })
  listener({
    data: {
      type: 'cio-webpush-received',
      deliveryId: 'delivery',
      title: 'Secret',
    },
  })
  expect(callback).not.toHaveBeenCalled()
  expect(received).not.toHaveBeenCalled()
  window.removeEventListener('cio:webpush:received', received)
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('switching identified users suppresses the previous registration handoff', async () => {
  const s = setup()
  await s.load()
  await s.analytics.webPush!.subscribe()
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  s.identify('another-person')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const callback = jest.fn()
  s.analytics.webPush!.onClick(callback)
  s.sw.addEventListener.mock.calls[0][1]({
    data: {
      type: 'cio-webpush-click',
      deliveryId: 'delivery',
      action: '',
      customData: { oldUser: true },
    },
  })
  expect(callback).not.toHaveBeenCalled()
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test.each([
  'legacy',
  'unchanged',
  'browser',
  'version',
  'os',
  'expiry',
  'clear expiry',
  'missing origin',
  'origin',
])('reconciliation updates attribute fingerprint for %s', async (kind) => {
  const s = setup()
  const ua = jest
    .spyOn(navigator, 'userAgent', 'get')
    .mockReturnValue('Mozilla/5.0 Chrome/155.0 Linux')
  try {
    if (kind === 'clear expiry') s.subscription.expirationTime = 100
    await s.load()
    await s.analytics.webPush!.subscribe()
    await s.plugin.unload?.(Context.system(), s.analytics)
    if (kind === 'legacy')
      localStorage.setItem(
        'cio-webpush:/cio-webpush-sw.js',
        JSON.stringify({ endpoint: value.endpoint, userId: 'person' })
      )
    if (kind === 'missing origin' || kind === 'origin') {
      // Browsers registered before the SDK sent origin, or under another one.
      const stored = record()
      const { origin, ...rest } = JSON.parse(stored.attributesFingerprint)
      expect(origin).toBe('http://localhost')
      const attributes =
        kind === 'origin' ? { ...rest, origin: 'https://other.example' } : rest
      localStorage.setItem(
        'cio-webpush:/cio-webpush-sw.js',
        JSON.stringify({
          ...stored,
          attributesFingerprint: JSON.stringify(attributes),
        })
      )
    }
    if (kind === 'browser')
      ua.mockReturnValue('Mozilla/5.0 Firefox/155.0 Linux')
    if (kind === 'version') ua.mockReturnValue('Mozilla/5.0 Chrome/156.0 Linux')
    if (kind === 'os')
      ua.mockReturnValue('Mozilla/5.0 Chrome/155.0 Windows NT 10.0')
    const next = setup()
    if (kind === 'expiry') next.subscription.expirationTime = 200
    next.manager.getSubscription.mockResolvedValue(next.subscription)
    await next.load()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(next.analytics.track).toHaveBeenCalledTimes(
      kind === 'unchanged' ? 0 : 1
    )
    if (kind === 'clear expiry')
      expect(jest.mocked(next.analytics.track).mock.calls[0][1]).toMatchObject({
        webpush_expiration_time: null,
      })
    if (kind !== 'unchanged')
      expect(jest.mocked(next.analytics.track).mock.calls[0][1]).toMatchObject({
        origin: 'http://localhost',
      })
    await next.plugin.unload?.(Context.system(), next.analytics)
    const again = setup()
    again.subscription.expirationTime = next.subscription.expirationTime
    again.manager.getSubscription.mockResolvedValue(again.subscription)
    await again.load()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(again.analytics.track).not.toHaveBeenCalled()
    await again.plugin.unload?.(Context.system(), again.analytics)
  } finally {
    ua.mockRestore()
  }
})

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

test('concurrent subscribe calls all succeed during key rotation', async () => {
  const s = setup()
  // Stateful PushManager: a subscription can be unsubscribed only once.
  let live: any = {
    ...s.subscription,
    options: {
      applicationServerKey: Uint8Array.from([4, ...Array(64).fill(98)]).buffer,
    },
  }
  const old = live
  old.unsubscribe = jest.fn(async () => {
    if (live !== old) return false
    live = null
    return true
  })
  s.manager.getSubscription.mockImplementation(async () => live)
  s.manager.subscribe.mockImplementation(async () => {
    live ??= { ...s.subscription, unsubscribe: jest.fn(async () => true) }
    return live
  })
  await s.load()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5].map(() => s.analytics.webPush!.subscribe())
  )

  expect(results.map((r) => r.status)).toEqual(Array(5).fill('fulfilled'))
  expect(live).not.toBe(old)
  await s.plugin.unload?.(Context.system(), s.analytics)
})

describe('subscribe and unsubscribe during key rotation', () => {
  // Stateful PushManager: a subscription can be unsubscribed once, and the
  // paused first unsubscribe lets a second caller see the old subscription.
  const rotating = async () => {
    const s = setup()
    let live: any = {
      ...s.subscription,
      options: {
        applicationServerKey: Uint8Array.from([4, ...Array(64).fill(98)])
          .buffer,
      },
    }
    let release!: () => void
    const paused = new Promise<void>((resolve) => (release = resolve))
    const old = live
    old.unsubscribe = jest.fn(async () => {
      await paused
      if (live !== old) return false
      live = null
      return true
    })
    s.manager.getSubscription.mockImplementation(async () => live)
    s.manager.subscribe.mockImplementation(async () => {
      live = {
        ...s.subscription,
        unsubscribe: jest.fn(async () => {
          live = null
          return true
        }),
      }
      return live
    })
    await s.load()
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { s, release, current: () => live }
  }

  test('unsubscribe called during a rotating subscribe settles after it', async () => {
    const { s, release, current } = await rotating()
    const sub = s.analytics.webPush!.subscribe()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const unsub = s.analytics.webPush!.unsubscribe()
    release()

    const results = await Promise.allSettled([sub, unsub])

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(current()).toBeNull()
    await s.plugin.unload?.(Context.system(), s.analytics)
  })

  test('anonymous subscribe, switch and unsubscribe leaves no browser subscription', async () => {
    const s = setup(null)
    let live: any = null
    s.manager.getSubscription.mockImplementation(async () => live)
    s.manager.subscribe.mockImplementation(async () => {
      live = {
        ...s.subscription,
        unsubscribe: jest.fn(async () => {
          live = null
          return true
        }),
      }
      return live
    })
    // Each worker path has its own activated registration over one manager.
    const registrationFor = (url: string) => ({
      ...s.registration,
      active: {
        state: 'activated',
        scriptURL: new URL(url, location.href).href,
      },
    })
    s.sw.getRegistration.mockImplementation(async (url: string) =>
      registrationFor(url)
    )
    s.sw.register.mockImplementation(async (url: string) =>
      registrationFor(url)
    )
    await s.load()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const first = s.analytics.webPush!.subscribe()
    const second = s.analytics.webPush!.subscribe({
      serviceWorkerUrl: '/other/cio-webpush-sw.js',
    })
    const unsub = s.analytics.webPush!.unsubscribe()
    // Registration waits for identify() forever; unsubscribe must not.
    const outcome = await Promise.race([
      unsub.then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 200)),
    ])

    expect(outcome).toBe('done')
    expect(live).toBeNull()
    await s.plugin.unload?.(Context.system(), s.analytics)
    await Promise.allSettled([first, second])
  })

  test('subscribe called during an unsubscribe waits for it', async () => {
    const { s, release, current } = await rotating()
    const unsub = s.analytics.webPush!.unsubscribe()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const sub = s.analytics.webPush!.subscribe()
    release()

    const results = await Promise.allSettled([unsub, sub])

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(current()).not.toBeNull()
    await s.plugin.unload?.(Context.system(), s.analytics)
  })
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

test('retains a fallback rotation owner after failed deletion so reload and reset retry', async () => {
  const s = setup()
  await s.load()
  await new Promise((resolve) => setTimeout(resolve, 0))
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  s.manager.subscribe.mockRejectedValueOnce(
    new DOMException('different key', 'InvalidStateError')
  )
  const track = jest.mocked(s.analytics.track)
  track.mockRejectedValueOnce(new Error('offline'))

  await expect(s.analytics.webPush!.subscribe()).rejects.toThrow('offline')

  expect(s.manager.subscribe).toHaveBeenCalledTimes(1)
  expect(s.subscription.unsubscribe).toHaveBeenCalledTimes(1)
  expect(track.mock.calls.map(([event]) => event)).toEqual(['Device Deleted'])
  expect(
    JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
  ).toMatchObject({
    endpoint: value.endpoint,
    userId: 'person',
    pendingDelete: {
      webpush_seq: expect.any(Number),
      webpush_event_ms: expect.any(Number),
    },
  })
  await s.plugin.unload?.(Context.system(), s.analytics)

  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 30001)
  const reloaded = setup()
  await reloaded.load()
  await new Promise((resolve) => setTimeout(resolve, 0))
  reloaded.reset()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(reloaded.analytics.track).toHaveBeenCalledTimes(1)
  expect(reloaded.analytics.track).toHaveBeenCalledWith(
    'Device Deleted',
    {},
    {
      timestamp: expect.any(Date),
      userId: 'person',
      anonymousId: null,
      context: {
        device: {
          token: value.endpoint,
          type: 'web',
          webpush_seq: expect.any(Number),
          webpush_event_ms: expect.any(Number),
        },
      },
    }
  )
  expect(
    JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
  ).toEqual({ endpoint: value.endpoint, userId: null })
  await reloaded.plugin.unload?.(Context.system(), reloaded.analytics)
  clock.mockRestore()
})

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
    '/notifications/cio-webpush-sw.js?track=https%3A%2F%2Ftrack.customer.io&runtime=off'
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
    '/host-worker.js?track=https%3A%2F%2Ftrack.customer.io&runtime=off'
  )
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test.each([
  [undefined, '&runtime=off'],
  [true, ''],
  [
    '/cio/cio-webpush-sw-runtime.v1.js',
    '&runtime=%2Fcio%2Fcio-webpush-sw-runtime.v1.js',
  ],
  [false, '&runtime=off'],
] as const)('passes runtimeUrl %j to the worker', async (runtimeUrl, query) => {
  const s = setup('person', { runtimeUrl })
  await s.load()
  await s.analytics.webPush!.subscribe()
  expect(s.sw.register).toHaveBeenCalledWith(
    `/cio-webpush-sw.js?track=https%3A%2F%2Ftrack.customer.io${query}`
  )
  await s.plugin.unload?.(Context.system(), s.analytics)
})

const usRuntime =
  'https://cdp.customer.io/v1/analytics-js/cio-webpush-sw-runtime.v1.js'
const tracked = '/cio-webpush-sw.js?track=https%3A%2F%2Ftrack.customer.io'
// No registration for the worker yet: the first install.
const firstInstall = (s: ReturnType<typeof setup>) =>
  s.sw.getRegistration.mockResolvedValue(undefined)
const installed = (s: ReturnType<typeof setup>, query: string) => {
  s.registration.active!.scriptURL = `http://localhost${tracked}${query}`
}
// Fire the preflight (3 s) and activation (30 s) deadlines immediately.
const fastDeadlines = () => {
  const delays: (number | undefined)[] = []
  const original = window.setTimeout
  jest.spyOn(window, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms?: number
  ) => {
    delays.push(ms)
    return original(callback, ms === 3000 || ms === 30000 ? 0 : ms)
  }) as typeof window.setTimeout)
  return delays
}

describe('runtime default', () => {
  test('a first install registers runtime=off without a preflight', async () => {
    const s = setup()
    firstInstall(s)
    await s.load()
    await s.analytics.webPush!.subscribe()
    expect(s.fetch).not.toHaveBeenCalled()
    expect(s.sw.register).toHaveBeenCalledWith(`${tracked}&runtime=off`)
    await s.plugin.unload?.(Context.system(), s.analytics)
  })

  test('an installed worker on the CDN runtime moves to runtime=off', async () => {
    const s = setup()
    installed(s, '')
    await s.load()
    await s.analytics.webPush!.subscribe()
    expect(s.fetch).not.toHaveBeenCalled()
    expect(s.sw.register).toHaveBeenCalledWith(`${tracked}&runtime=off`)
    await s.plugin.unload?.(Context.system(), s.analytics)
  })
})

describe('runtime preflight', () => {
  afterEach(() => jest.restoreAllMocks())
  const cdn = { runtimeUrl: true }

  test('a first install preflights the CDN runtime and keeps it when the host answers', async () => {
    const s = setup('person', cdn)
    firstInstall(s)
    await s.load()
    await s.analytics.webPush!.subscribe()
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(s.fetch).toHaveBeenCalledWith(
      usRuntime,
      expect.objectContaining({
        mode: 'no-cors',
        cache: 'no-store',
        credentials: 'omit',
      })
    )
    expect(s.sw.register).toHaveBeenCalledWith(tracked)
    await s.plugin.unload?.(Context.system(), s.analytics)
  })

  test('preflights the EU runtime for the EU track host', async () => {
    const s = setup('person', {
      trackUrl: 'https://track-eu.customer.io',
      runtimeUrl: true,
    })
    firstInstall(s)
    await s.load()
    await s.analytics.webPush!.subscribe()
    expect(s.fetch).toHaveBeenCalledWith(
      'https://cdp-eu.customer.io/v1/analytics-js/cio-webpush-sw-runtime.v1.js',
      expect.anything()
    )
    await s.plugin.unload?.(Context.system(), s.analytics)
  })

  test('a first install registers runtime=off when the runtime host is blocked', async () => {
    const s = setup('person', cdn)
    firstInstall(s)
    s.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await s.load()
    await expect(s.analytics.webPush!.subscribe()).resolves.toEqual(value)
    expect(s.sw.register).toHaveBeenCalledWith(`${tracked}&runtime=off`)
    await s.plugin.unload?.(Context.system(), s.analytics)
  })

  test('a first install registers runtime=off when the runtime host stalls for 3 s', async () => {
    const s = setup('person', cdn)
    firstInstall(s)
    let signal: AbortSignal | undefined
    s.fetch.mockImplementation((_url, init: RequestInit) => {
      signal = init.signal ?? undefined
      return new Promise(() => {})
    })
    const delays = fastDeadlines()
    await s.load()
    await expect(s.analytics.webPush!.subscribe()).resolves.toEqual(value)
    expect(delays).toContain(3000)
    expect(signal?.aborted).toBe(true)
    expect(s.sw.register).toHaveBeenCalledWith(`${tracked}&runtime=off`)
    await s.plugin.unload?.(Context.system(), s.analytics)
  })

  test('the preflight result is reused for the rest of the page load', async () => {
    const s = setup('person', cdn)
    firstInstall(s)
    s.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await s.load()
    await s.analytics.webPush!.subscribe()
    await s.analytics.webPush!.subscribe()
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(s.sw.register).toHaveBeenNthCalledWith(2, `${tracked}&runtime=off`)
    await s.plugin.unload?.(Context.system(), s.analytics)
  })

  test('an installed worker keeps the CDN runtime without a preflight', async () => {
    const s = setup('person', cdn)
    installed(s, '')
    await s.load()
    await s.analytics.webPush!.subscribe()
    expect(s.fetch).not.toHaveBeenCalled()
    expect(s.sw.register).toHaveBeenCalledWith(tracked)
    await s.plugin.unload?.(Context.system(), s.analytics)
  })

  test.each([
    [true, ''],
    [false, '&runtime=off'],
  ])(
    'opting in moves a runtime=off worker to the CDN only when reachable (%s)',
    async (reachable, query) => {
      const s = setup('person', cdn)
      installed(s, '&runtime=off')
      if (!reachable)
        s.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
      await s.load()
      await s.analytics.webPush!.subscribe()
      expect(s.fetch).toHaveBeenCalledTimes(1)
      expect(s.sw.register).toHaveBeenCalledWith(`${tracked}${query}`)
      await s.plugin.unload?.(Context.system(), s.analytics)
    }
  )

  test('a worker that is still installing does not count as installed', async () => {
    const s = setup('person', cdn)
    s.sw.getRegistration.mockResolvedValue({
      ...s.registration,
      active: null,
      installing: {
        state: 'installing',
        scriptURL: `http://localhost${tracked}`,
      },
    })
    s.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await s.load()
    await s.analytics.webPush!.subscribe()
    expect(s.sw.register).toHaveBeenCalledWith(`${tracked}&runtime=off`)
    await s.plugin.unload?.(Context.system(), s.analytics)
  })

  test('runtimeUrl: false never preflights', async () => {
    const s = setup('person', { runtimeUrl: false })
    firstInstall(s)
    await s.load()
    await s.analytics.webPush!.subscribe()
    expect(s.fetch).not.toHaveBeenCalled()
    expect(s.sw.register).toHaveBeenCalledWith(`${tracked}&runtime=off`)
    await s.plugin.unload?.(Context.system(), s.analytics)
  })

  test('a first-party runtimeUrl is preflighted at its resolved URL', async () => {
    const runtimeUrl = '/cio/cio-webpush-sw-runtime.v1.js'
    const s = setup('person', { runtimeUrl })
    firstInstall(s)
    await s.load()
    await s.analytics.webPush!.subscribe()
    expect(s.fetch).toHaveBeenCalledWith(
      `http://localhost${runtimeUrl}`,
      expect.anything()
    )
    expect(s.sw.register).toHaveBeenCalledWith(
      `${tracked}&runtime=${encodeURIComponent(runtimeUrl)}`
    )
    await s.plugin.unload?.(Context.system(), s.analytics)
  })

  test.each([
    [true, '&runtime=%2Fcio%2Fcio-webpush-sw-runtime.v1.js'],
    [false, '&runtime=off'],
  ])(
    'an explicit runtimeUrl re-enables a runtime=off worker only when reachable (%s)',
    async (reachable, query) => {
      const s = setup('person', {
        runtimeUrl: '/cio/cio-webpush-sw-runtime.v1.js',
      })
      installed(s, '&runtime=off')
      if (!reachable)
        s.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
      await s.load()
      await s.analytics.webPush!.subscribe()
      expect(s.fetch).toHaveBeenCalledTimes(1)
      expect(s.sw.register).toHaveBeenCalledWith(`${tracked}${query}`)
      await s.plugin.unload?.(Context.system(), s.analytics)
    }
  )

  test('a runtime query equivalent to the installed one is kept verbatim', async () => {
    const s = setup('person', { runtimeUrl: usRuntime })
    installed(s, '')
    await s.load()
    await s.analytics.webPush!.subscribe()
    expect(s.fetch).not.toHaveBeenCalled()
    expect(s.sw.register).toHaveBeenCalledWith(tracked)
    await s.plugin.unload?.(Context.system(), s.analytics)
  })
})

describe('activation deadline', () => {
  afterEach(() => jest.restoreAllMocks())

  test.each([
    ['register() never settles', 'register'],
    ['the worker never activates', 'activate'],
  ])('subscribe rejects after 30 s when %s', async (_, stall) => {
    const s = setup()
    const delays = fastDeadlines()
    if (stall === 'register')
      s.sw.register.mockReturnValue(new Promise(() => {}))
    else
      s.sw.register.mockResolvedValue({
        ...s.registration,
        active: null,
        installing: {
          state: 'installing',
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
      })
    await s.load()
    await expect(s.analytics.webPush!.subscribe()).rejects.toThrow(
      'Web push service worker did not activate within 30 seconds.'
    )
    expect(delays).toContain(30000)
    expect(s.manager.subscribe).not.toHaveBeenCalled()
    expect(s.analytics.track).not.toHaveBeenCalled()
    await s.plugin.unload?.(Context.system(), s.analytics)
  })
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
    '/cio-webpush-sw.js?track=https%3A%2F%2Ftrack.customer.io&runtime=off'
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
      ...deviceAttributes(navigator),
      origin: 'http://localhost',
      webpush_expiration_time: null,
    },
    {
      timestamp: expect.any(Date),
      userId: 'person',
      context: {
        device: {
          token: value.endpoint,
          type: 'web',
          webpush_seq: expect.any(Number),
          webpush_event_ms: expect.any(Number),
        },
      },
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
      timestamp: expect.any(Date),
      userId: 'person',
      context: {
        device: {
          token: value.endpoint,
          type: 'web',
          webpush_seq: expect.any(Number),
          webpush_event_ms: expect.any(Number),
        },
      },
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
  await new Promise((resolve) => setTimeout(resolve, 0))
  jest.mocked(s.analytics.track).mockClear()
  await s.analytics.webPush!.unsubscribe()
  expect(s.subscription.unsubscribe).toHaveBeenCalled()
  expect(s.analytics.track).toHaveBeenCalledWith(
    'Device Deleted',
    {},
    {
      timestamp: expect.any(Date),
      userId: 'person',
      anonymousId: null,
      context: {
        device: {
          token: value.endpoint,
          type: 'web',
          webpush_seq: expect.any(Number),
          webpush_event_ms: expect.any(Number),
        },
      },
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
  await new Promise((resolve) => setTimeout(resolve, 0))
  ;(s.analytics.track as jest.Mock).mockRejectedValueOnce(new Error('offline'))
  await expect(s.analytics.webPush!.unsubscribe()).rejects.toThrow('offline')
  expect(
    JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
  ).toMatchObject({
    endpoint: value.endpoint,
    userId: 'person',
    pendingDelete: {
      webpush_seq: expect.any(Number),
      webpush_event_ms: expect.any(Number),
    },
  })
  s.manager.getSubscription.mockResolvedValue(null)
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 30001)
  await s.analytics.webPush!.unsubscribe()
  clock.mockRestore()
  expect(s.analytics.track).toHaveBeenLastCalledWith(
    'Device Deleted',
    {},
    {
      timestamp: expect.any(Date),
      userId: 'person',
      anonymousId: null,
      context: {
        device: {
          token: value.endpoint,
          type: 'web',
          webpush_seq: expect.any(Number),
          webpush_event_ms: expect.any(Number),
        },
      },
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
  ).toMatchObject({
    endpoint: 'https://push.example/previous',
    userId: 'person',
    pendingDelete: {
      webpush_seq: expect.any(Number),
      webpush_event_ms: expect.any(Number),
    },
  })
  await s.plugin.unload?.(Context.system(), s.analytics)

  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 30001)
  const reloaded = setup()
  await reloaded.load()
  await reloaded.analytics.webPush!.subscribe()
  expect(
    (reloaded.analytics.track as jest.Mock).mock.calls.map(([event]) => event)
  ).toEqual(['Device Deleted', 'Device Created or Updated'])
  await reloaded.plugin.unload?.(Context.system(), reloaded.analytics)
  clock.mockRestore()
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

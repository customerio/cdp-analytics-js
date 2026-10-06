import unfetch from 'unfetch'
import { AnalyticsBrowser } from '..'
import type { Analytics } from '../../core/analytics'
import type { CustomerioEvent } from '../../core/events/interfaces'
import { createSuccess } from '../../test-helpers/factories'

jest.mock('unfetch')
const name = 'Customer.io Web Push Plugin'
const keyBytes = new Uint8Array([4, ...Array(64).fill(97)])
const key = btoa(String.fromCharCode(...Array.from(keyBytes)))
const loaded: Analytics[] = []

beforeEach(() => {
  for (const cookie of document.cookie.split(';')) {
    document.cookie = `${cookie.split('=')[0].trim()}=; Max-Age=0; path=/`
  }
  localStorage.clear()
  jest
    .mocked(unfetch)
    .mockImplementation(() => createSuccess({ integrations: {} }))
})
afterEach(async () => {
  for (const analytics of loaded.splice(0)) await analytics.deregister(name)
  delete (navigator as any).serviceWorker
  delete (window as any).PushManager
  delete (window as any).Notification
})

function browser() {
  let current: PushSubscription | null = null
  const subscription = (
    endpoint: string,
    applicationServerKey = keyBytes.buffer
  ) => {
    const value = { endpoint, keys: { p256dh: 'p256dh', auth: 'auth' } }
    return {
      endpoint,
      options: { applicationServerKey },
      toJSON: () => value,
      unsubscribe: jest.fn(async () => {
        current = null
        return true
      }),
    } as unknown as PushSubscription
  }
  const initial = subscription('https://push.example/old')
  const replacement = subscription('https://push.example/new')
  const manager = {
    getSubscription: jest.fn(async () => current),
    subscribe: jest.fn(async () => {
      current = replacement
      return current
    }),
  }
  const registration = {
    active: {
      state: 'activated',
      scriptURL: 'http://localhost/cio-webpush-sw.js',
    },
    pushManager: manager,
  }
  const sw = {
    getRegistration: jest.fn(async (url: string) =>
      new URL(url, location.href).pathname ===
      new URL(registration.active.scriptURL).pathname
        ? registration
        : undefined
    ),
    register: jest.fn(async (url: string) => {
      registration.active.scriptURL = new URL(url, location.href).href
      return registration
    }),
    addEventListener: jest.fn(
      (_name: string, _listener: (event: any) => void) => {}
    ),
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
  return {
    sw,
    manager,
    initial,
    replacement,
    registration,
    setLive: (value: PushSubscription | null) => {
      current = value
    },
  }
}

async function load() {
  const events: CustomerioEvent[] = []
  const [analytics] = await AnalyticsBrowser.load(
    {
      writeKey: 'foo',
      plugins: [
        {
          name: 'Device event collector',
          type: 'destination',
          version: '1.0.0',
          isLoaded: () => true,
          load: async () => {},
          track: (ctx) => {
            events.push(ctx.event)
            return ctx
          },
        },
      ],
    },
    { integrations: { [name]: { vapidPublicKey: key } } }
  )
  loaded.push(analytics)
  return { analytics, events }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Device event did not settle')
}
const eventShape = (events: CustomerioEvent[]) =>
  events.map((event) => ({
    event: event.event,
    userId: event.userId,
    device: event.context?.device,
  }))

test('identify A → subscribe → reset → identify B deletes A and registers B', async () => {
  browser()
  const { analytics, events } = await load()
  await analytics.identify('A')
  await analytics.webPush!.subscribe()
  analytics.reset()
  await analytics.identify('B')
  await until(() => events.length === 3)
  expect(eventShape(events)).toEqual([
    {
      event: 'Device Created or Updated',
      userId: 'A',
      device: { token: 'https://push.example/new', type: 'web' },
    },
    {
      event: 'Device Deleted',
      userId: 'A',
      device: { token: 'https://push.example/new', type: 'web' },
    },
    {
      event: 'Device Created or Updated',
      userId: 'B',
      device: { token: 'https://push.example/new', type: 'web' },
    },
  ])
  expect(events[0].properties).toEqual({
    webpush_p256dh: 'p256dh',
    webpush_auth: 'auth',
    user_agent: navigator.userAgent,
  })
  expect(
    JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
  ).toEqual({ endpoint: 'https://push.example/new', userId: 'B' })
})

test('identity switch without reset also deletes the stored owner', async () => {
  browser()
  const { analytics, events } = await load()
  await analytics.identify('A')
  await analytics.webPush!.subscribe()
  await analytics.identify('B')
  await until(() => events.length === 3)
  expect(
    eventShape(events).map(({ event, userId }) => [event, userId])
  ).toEqual([
    ['Device Created or Updated', 'A'],
    ['Device Deleted', 'A'],
    ['Device Created or Updated', 'B'],
  ])
})

test('unsubscribe after reset turns off the browser and settles without identify', async () => {
  const b = browser()
  const { analytics, events } = await load()
  await analytics.identify('A')
  await analytics.webPush!.subscribe()
  analytics.reset()
  await analytics.webPush!.unsubscribe()
  expect(b.replacement.unsubscribe).toHaveBeenCalledTimes(1)
  expect(await analytics.webPush!.subscription()).toBeNull()
  expect(
    events
      .filter((event) => event.event === 'Device Deleted')
      .map((event) => event.userId)
  ).toEqual(['A'])
  expect(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')).toBeNull()
})

test('throwing serviceWorker getter leaves push inert and AnalyticsBrowser.load resolves', async () => {
  browser()
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    get: () => {
      throw new DOMException('sandboxed iframe', 'SecurityError')
    },
  })
  const { analytics, events } = await load()
  expect(analytics.webPush).toBeUndefined()
  await analytics.identify('A')
  await analytics.track('Still working')
  expect(events[0].event).toBe('Still working')
})

test('per-call worker URL survives reload for lookup, reconciliation and unsubscribe', async () => {
  const b = browser()
  const first = await load()
  await first.analytics.identify('A')
  await first.analytics.webPush!.subscribe({
    serviceWorkerUrl: '/push/cio-webpush-sw.js',
  })
  await first.analytics.deregister(name)
  // A changed endpoint must be found via the persisted path on the next load.
  b.setLive(b.initial)
  const second = await load()
  await until(() => second.events.length === 2)
  expect(b.sw.getRegistration).toHaveBeenLastCalledWith(
    '/push/cio-webpush-sw.js'
  )
  expect((await second.analytics.webPush!.subscription())?.endpoint).toBe(
    b.initial.endpoint
  )
  expect(
    eventShape(second.events).map(({ event, device }) => [event, device?.token])
  ).toEqual([
    ['Device Deleted', b.replacement.endpoint],
    ['Device Created or Updated', b.initial.endpoint],
  ])
  await second.analytics.webPush!.unsubscribe()
  expect(b.initial.unsubscribe).toHaveBeenCalledTimes(1)
})

test('VAPID rotation unsubscribes and deletes before subscribing with the new key', async () => {
  const b = browser()
  const { analytics, events } = await load()
  await analytics.identify('A')
  await analytics.webPush!.subscribe()
  const rotated = new Uint8Array([4, ...Array(64).fill(98)])
  const next = {
    ...b.initial,
    options: { applicationServerKey: rotated.buffer },
  } as PushSubscription
  b.manager.subscribe.mockImplementationOnce(async () => {
    b.setLive(next)
    return next
  })
  b.manager.subscribe.mockClear()
  const track = jest.spyOn(analytics, 'track')
  await analytics.webPush!.subscribe({
    vapidPublicKey: btoa(String.fromCharCode(...Array.from(rotated))),
  })
  expect(b.replacement.unsubscribe).toHaveBeenCalledTimes(1)
  expect(b.manager.subscribe).toHaveBeenCalledWith({
    userVisibleOnly: true,
    applicationServerKey: rotated,
  })
  expect(
    eventShape(events).map(({ event, userId }) => [event, userId])
  ).toEqual([
    ['Device Created or Updated', 'A'],
    ['Device Deleted', 'A'],
    ['Device Created or Updated', 'A'],
  ])
  expect(
    (b.replacement.unsubscribe as jest.Mock).mock.invocationCallOrder[0]
  ).toBeLessThan(b.manager.subscribe.mock.invocationCallOrder[0])
  expect(track.mock.calls[0][0]).toBe('Device Deleted')
  expect(track.mock.invocationCallOrder[0]).toBeLessThan(
    b.manager.subscribe.mock.invocationCallOrder[0]
  )
  track.mockRestore()
  expect(b.manager.subscribe).toHaveBeenCalledTimes(1)
})

test('changing worker path after reload deletes the persisted subscription owner', async () => {
  const b = browser()
  const first = await load()
  await first.analytics.identify('A')
  await first.analytics.webPush!.subscribe()
  await first.analytics.deregister(name)
  const second = await load()
  expect((await second.analytics.webPush!.subscription())?.endpoint).toBe(
    b.replacement.endpoint
  )
  expect(second.events).toEqual([])
  b.manager.subscribe.mockImplementationOnce(async () => {
    b.setLive(b.initial)
    return b.initial
  })
  await second.analytics.webPush!.subscribe({
    serviceWorkerUrl: '/notifications/cio-webpush-sw.js',
  })
  expect(eventShape(second.events)).toEqual([
    {
      event: 'Device Deleted',
      userId: 'A',
      device: { token: b.replacement.endpoint, type: 'web' },
    },
    {
      event: 'Device Created or Updated',
      userId: 'A',
      device: { token: b.initial.endpoint, type: 'web' },
    },
  ])
})

test('worker message deletes the old endpoint before registering its replacement', async () => {
  const b = browser()
  const { analytics, events } = await load()
  await analytics.identify('A')
  await analytics.webPush!.subscribe()
  b.setLive(b.initial)
  b.sw.addEventListener.mock.calls[0][1]({
    data: { type: 'cio-webpush-subscriptionchange' },
  })
  await until(() => events.length === 3)
  expect(
    eventShape(events).map(({ event, device }) => [event, device?.token])
  ).toEqual([
    ['Device Created or Updated', b.replacement.endpoint],
    ['Device Deleted', b.replacement.endpoint],
    ['Device Created or Updated', b.initial.endpoint],
  ])
})

test('unchanged VAPID key keeps the existing subscription', async () => {
  const b = browser()
  const { analytics } = await load()
  await analytics.identify('A')
  await analytics.webPush!.subscribe()
  await analytics.webPush!.subscribe()
  expect(b.replacement.unsubscribe).not.toHaveBeenCalled()
})

test('anonymous unregistered subscription can be turned off without identity', async () => {
  const b = browser()
  const { analytics, events } = await load()
  b.setLive(b.initial)
  await analytics.webPush!.unsubscribe()
  expect(b.initial.unsubscribe).toHaveBeenCalledTimes(1)
  expect(events).toEqual([])
})

test('subscription returns null on unsupported browsers', async () => {
  browser()
  delete (window as any).PushManager
  const { analytics } = await load()
  expect(await analytics.webPush!.subscription()).toBeNull()
})

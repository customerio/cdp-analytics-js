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

// Each registered scope retains its own browser subscription.
function scopedBrowser() {
  const createRegistration = (
    path: string,
    scope: string,
    endpoint: string
  ) => {
    let subscribed = false
    const value = { endpoint, keys: { p256dh: 'p256dh', auth: 'auth' } }
    const subscription = {
      endpoint,
      options: { applicationServerKey: keyBytes.buffer },
      toJSON: () => value,
      unsubscribe: jest.fn(async () => {
        subscribed = false
        return true
      }),
    }
    const manager = {
      getSubscription: jest.fn(async () => (subscribed ? subscription : null)),
      subscribe: jest.fn(async () => {
        subscribed = true
        return subscription
      }),
    }
    return {
      value,
      subscription,
      manager,
      registration: {
        scope: new URL(scope, location.href).href,
        active: {
          state: 'activated',
          scriptURL: new URL(path, location.href).href,
        },
        pushManager: manager,
      },
    }
  }
  const old = createRegistration(
    '/cio-webpush-sw.js',
    '/',
    'https://push.example/old-scope'
  )
  const destination = createRegistration(
    '/notifications/cio-webpush-sw.js',
    '/notifications/',
    'https://push.example/new-scope'
  )
  const alternate = createRegistration(
    '/alternate/cio-webpush-sw.js',
    '/alternate/',
    'https://push.example/alternate-scope'
  )
  let destinationRegistered = false
  let alternateRegistered = false
  const sw = {
    getRegistration: jest.fn(async (url: string) => {
      const path = new URL(url, location.href).pathname
      if (destinationRegistered && path.startsWith('/notifications/'))
        return destination.registration
      if (alternateRegistered && path.startsWith('/alternate/'))
        return alternate.registration
      return old.registration
    }),
    register: jest.fn(async (url: string) => {
      const path = new URL(url, location.href).pathname
      if (path === '/cio-webpush-sw.js') return old.registration
      if (path === '/notifications/cio-webpush-sw.js') {
        destinationRegistered = true
        return destination.registration
      }
      if (path === '/alternate/cio-webpush-sw.js') {
        alternateRegistered = true
        return alternate.registration
      }
      throw new Error('Unexpected worker path')
    }),
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
  return { old, destination, alternate, sw }
}

test.each(['identify without reset', 'lookup after reload', 'unsubscribe'])(
  'a failed switch to an empty destination preserves the previous path for %s',
  async (operation) => {
    const b = scopedBrowser()
    const first = await load()
    await first.analytics.identify('A')
    await first.analytics.webPush!.subscribe()
    b.destination.manager.subscribe.mockRejectedValueOnce(
      new Error('push service unavailable')
    )

    await expect(
      first.analytics.webPush!.subscribe({
        serviceWorkerUrl: '/notifications/cio-webpush-sw.js',
      })
    ).rejects.toThrow('push service unavailable')
    expect((await b.old.manager.getSubscription())?.endpoint).toBe(
      b.old.value.endpoint
    )
    expect(await b.destination.manager.getSubscription()).toBeNull()

    if (operation === 'identify without reset') {
      await first.analytics.identify('B')
      await until(() => first.events.length >= 3)
      // Rollback and identify can both reconcile; an extra B upsert is allowed.
      expect(eventShape(first.events).slice(1, 3)).toEqual([
        {
          event: 'Device Deleted',
          userId: 'A',
          device: { token: b.old.value.endpoint, type: 'web' },
        },
        {
          event: 'Device Created or Updated',
          userId: 'B',
          device: { token: b.old.value.endpoint, type: 'web' },
        },
      ])
      expect(
        JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
      ).toEqual({ endpoint: b.old.value.endpoint, userId: 'B' })
    } else if (operation === 'lookup after reload') {
      await first.analytics.deregister(name)
      const reloaded = await load()
      const actual = await reloaded.analytics.webPush!.subscription()
      expect(actual).toEqual(b.old.value)
    } else {
      await first.analytics.webPush!.unsubscribe()
      expect(b.old.subscription.unsubscribe).toHaveBeenCalledTimes(1)
      expect(eventShape(first.events).slice(1)).toEqual([
        {
          event: 'Device Deleted',
          userId: 'A',
          device: { token: b.old.value.endpoint, type: 'web' },
        },
      ])
    }
  }
)

test('identify while an empty destination subscribe is pending reconciles the old scope after failure', async () => {
  const b = scopedBrowser()
  const { analytics, events } = await load()
  await analytics.identify('A')
  await analytics.webPush!.subscribe()
  let rejectSubscription: (error: Error) => void = () => {
    throw new Error('Destination subscribe has not started')
  }
  let started: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    started = resolve
  })
  b.destination.manager.subscribe.mockImplementationOnce(
    () =>
      new Promise<typeof b.destination.subscription>((_resolve, reject) => {
        rejectSubscription = reject
        started()
      })
  )
  const switching = analytics.webPush!.subscribe({
    serviceWorkerUrl: '/notifications/cio-webpush-sw.js',
  })
  const rejected = expect(switching).rejects.toThrow('push service unavailable')
  await pending
  await analytics.identify('B')
  rejectSubscription(new Error('push service unavailable'))
  await rejected
  await until(() => events.length === 3)

  expect(eventShape(events).slice(1)).toEqual([
    {
      event: 'Device Deleted',
      userId: 'A',
      device: { token: b.old.value.endpoint, type: 'web' },
    },
    {
      event: 'Device Created or Updated',
      userId: 'B',
      device: { token: b.old.value.endpoint, type: 'web' },
    },
  ])
})

test('a failed destination rotation retains its owner and selection for reload/reset retry', async () => {
  const b = scopedBrowser()
  const first = await load()
  await first.analytics.identify('A')
  await first.analytics.webPush!.subscribe()
  await b.destination.manager.subscribe()
  b.destination.subscription.options.applicationServerKey = Uint8Array.from([
    4,
    ...Array(64).fill(98),
  ]).buffer
  const previous = JSON.stringify({
    endpoint: b.destination.value.endpoint,
    userId: 'other',
  })
  localStorage.setItem('cio-webpush:/notifications/cio-webpush-sw.js', previous)
  const track = jest.spyOn(first.analytics, 'track')
  track.mockRejectedValueOnce(new Error('offline delete'))

  await expect(
    first.analytics.webPush!.subscribe({
      serviceWorkerUrl: '/notifications/cio-webpush-sw.js',
    })
  ).rejects.toThrow('offline delete')

  expect(b.destination.subscription.unsubscribe).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem('cio-webpush:worker:/cio-webpush-sw.js')).toBe(
    '/notifications/cio-webpush-sw.js'
  )
  expect(
    localStorage.getItem('cio-webpush:/notifications/cio-webpush-sw.js')
  ).toBe(previous)
  track.mockRestore()
  await first.analytics.deregister(name)

  const reloaded = await load()
  reloaded.analytics.reset()
  await until(() => reloaded.events.length === 1)
  expect(eventShape(reloaded.events)).toEqual([
    {
      event: 'Device Deleted',
      userId: 'other',
      device: { token: b.destination.value.endpoint, type: 'web' },
    },
  ])
})

test('a new destination subscription remains reachable when device deletion fails and retries after reload', async () => {
  const b = scopedBrowser()
  const first = await load()
  await first.analytics.identify('A')
  await first.analytics.webPush!.subscribe()
  const track = jest.spyOn(first.analytics, 'track')
  track.mockRejectedValueOnce(new Error('offline delete'))

  await expect(
    first.analytics.webPush!.subscribe({
      serviceWorkerUrl: '/notifications/cio-webpush-sw.js',
    })
  ).rejects.toThrow('offline delete')

  await expect(first.analytics.webPush!.subscription()).resolves.toEqual(
    b.destination.value
  )
  expect(
    JSON.parse(
      localStorage.getItem('cio-webpush:/notifications/cio-webpush-sw.js')!
    )
  ).toEqual({ endpoint: b.old.value.endpoint, userId: 'A' })
  track.mockRestore()
  await first.analytics.deregister(name)

  const reloaded = await load()
  await until(() => reloaded.events.length === 2)
  expect(eventShape(reloaded.events)).toEqual([
    {
      event: 'Device Deleted',
      userId: 'A',
      device: { token: b.old.value.endpoint, type: 'web' },
    },
    {
      event: 'Device Created or Updated',
      userId: 'A',
      device: { token: b.destination.value.endpoint, type: 'web' },
    },
  ])
})

test('a stored destination owner survives failed browser subscription without deletion', async () => {
  const b = scopedBrowser()
  const { analytics, events } = await load()
  await analytics.identify('A')
  await analytics.webPush!.subscribe()
  const previous = JSON.stringify({
    endpoint: b.destination.value.endpoint,
    userId: 'other',
  })
  localStorage.setItem('cio-webpush:/notifications/cio-webpush-sw.js', previous)
  b.destination.manager.subscribe.mockRejectedValueOnce(
    new Error('push service unavailable')
  )

  await expect(
    analytics.webPush!.subscribe({
      serviceWorkerUrl: '/notifications/cio-webpush-sw.js',
    })
  ).rejects.toThrow('push service unavailable')

  expect(
    localStorage.getItem('cio-webpush:/notifications/cio-webpush-sw.js')
  ).toBe(previous)
  expect(eventShape(events).slice(1)).toEqual([])
  expect(localStorage.getItem('cio-webpush:worker:/cio-webpush-sw.js')).toBe(
    '/cio-webpush-sw.js'
  )
  await expect(analytics.webPush!.subscription()).resolves.toEqual(b.old.value)
})

test.each(['same path', 'different path'])(
  'a stale failed switch does not hide a later successful subscribe at the %s',
  async (target) => {
    const b = scopedBrowser()
    const { analytics } = await load()
    await analytics.identify('A')
    await analytics.webPush!.subscribe()
    let rejectSubscription: (error: Error) => void = () => {
      throw new Error('Destination subscribe has not started')
    }
    let started: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      started = resolve
    })
    b.destination.manager.subscribe.mockImplementationOnce(
      () =>
        new Promise<typeof b.destination.subscription>((_resolve, reject) => {
          rejectSubscription = reject
          started()
        })
    )
    const switching = analytics.webPush!.subscribe({
      serviceWorkerUrl: '/notifications/cio-webpush-sw.js',
    })
    const rejected = expect(switching).rejects.toThrow(
      'push service unavailable'
    )
    await pending
    const path =
      target === 'same path'
        ? '/notifications/cio-webpush-sw.js'
        : '/alternate/cio-webpush-sw.js'
    const newer = target === 'same path' ? b.destination : b.alternate
    await expect(
      analytics.webPush!.subscribe({ serviceWorkerUrl: path })
    ).resolves.toEqual(newer.value)
    const owner = localStorage.getItem(`cio-webpush:${path}`)
    expect(JSON.parse(owner!)).toEqual({
      endpoint: newer.value.endpoint,
      userId: 'A',
    })
    rejectSubscription(new Error('push service unavailable'))
    await rejected

    expect(localStorage.getItem('cio-webpush:worker:/cio-webpush-sw.js')).toBe(
      path
    )
    expect(localStorage.getItem(`cio-webpush:${path}`)).toBe(owner)
    await expect(analytics.webPush!.subscription()).resolves.toEqual(
      newer.value
    )
  }
)

test('a failed destination lookup preserves the previous selection and existing destination subscription', async () => {
  const b = scopedBrowser()
  const { analytics, events } = await load()
  await analytics.identify('A')
  await analytics.webPush!.subscribe()
  await b.destination.manager.subscribe()
  const previous = JSON.stringify({
    endpoint: b.destination.value.endpoint,
    userId: 'other',
  })
  localStorage.setItem('cio-webpush:/notifications/cio-webpush-sw.js', previous)
  b.destination.manager.getSubscription.mockRejectedValueOnce(
    new Error('subscription lookup failed')
  )

  await expect(
    analytics.webPush!.subscribe({
      serviceWorkerUrl: '/notifications/cio-webpush-sw.js',
    })
  ).rejects.toThrow('subscription lookup failed')

  expect(localStorage.getItem('cio-webpush:worker:/cio-webpush-sw.js')).toBe(
    '/cio-webpush-sw.js'
  )
  expect(
    localStorage.getItem('cio-webpush:/notifications/cio-webpush-sw.js')
  ).toBe(previous)
  await expect(analytics.webPush!.subscription()).resolves.toEqual(b.old.value)
  expect((await b.destination.manager.getSubscription())?.endpoint).toBe(
    b.destination.value.endpoint
  )
  expect(eventShape(events).slice(1)).toEqual([])
})

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
  const anonymousId = analytics.user().anonymousId()
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
  expect(JSON.parse(JSON.stringify(events[1]))).not.toHaveProperty(
    'anonymousId'
  )
  expect(events[2].anonymousId).toBe(anonymousId)
  expect(analytics.user().anonymousId()).toBe(anonymousId)
  expect(
    JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
  ).toEqual({ endpoint: 'https://push.example/new', userId: 'B' })
})

test('delayed deletion of a persisted owner never attaches the new visitor identity', async () => {
  browser()
  localStorage.setItem(
    'cio-webpush:/cio-webpush-sw.js',
    JSON.stringify({ endpoint: 'https://push.example/old', userId: 'A' })
  )
  const { analytics, events } = await load()
  let release!: () => void
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  const track = analytics.track.bind(analytics)
  jest
    .spyOn(analytics, 'track')
    .mockImplementation((...args) =>
      args[0] === 'Device Deleted'
        ? delayed.then(() => track(...args))
        : track(...args)
    )
  analytics.reset()
  const anonymousId = analytics.user().anonymousId()
  await analytics.identify('B')
  await analytics.track('New visitor action')
  release()
  await until(() => events.some((event) => event.event === 'Device Deleted'))
  const deleted = events.find((event) => event.event === 'Device Deleted')!
  expect(deleted.userId).toBe('A')
  expect(JSON.parse(JSON.stringify(deleted))).not.toHaveProperty('anonymousId')
  expect(analytics.user().id()).toBe('B')
  expect(analytics.user().anonymousId()).toBe(anonymousId)
  expect(
    events.find((event) => event.event === 'New visitor action')!.anonymousId
  ).toBe(anonymousId)
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

test('failed worker path switch keeps the previous path for reset after reload', async () => {
  const b = scopedBrowser()
  const first = await load()
  await first.analytics.identify('A')
  await first.analytics.webPush!.subscribe()
  b.destination.manager.subscribe.mockRejectedValueOnce(
    new Error('push service unavailable')
  )
  await expect(
    first.analytics.webPush!.subscribe({
      serviceWorkerUrl: '/notifications/cio-webpush-sw.js',
    })
  ).rejects.toThrow('push service unavailable')
  expect(localStorage.getItem('cio-webpush:worker:/cio-webpush-sw.js')).toBe(
    '/cio-webpush-sw.js'
  )
  expect(
    localStorage.getItem('cio-webpush:/notifications/cio-webpush-sw.js')
  ).toBeNull()
  await first.analytics.deregister(name)

  const second = await load()
  await expect(second.analytics.webPush!.subscription()).resolves.toEqual(
    b.old.value
  )
  second.analytics.reset()
  await until(() => second.events.length === 1)
  expect(b.sw.getRegistration).toHaveBeenLastCalledWith('/cio-webpush-sw.js')
  expect(eventShape(second.events)).toEqual([
    {
      event: 'Device Deleted',
      userId: 'A',
      device: { token: b.old.value.endpoint, type: 'web' },
    },
  ])
  expect(
    JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
  ).toEqual({ endpoint: b.old.value.endpoint, userId: null })
  expect(
    localStorage.getItem('cio-webpush:/notifications/cio-webpush-sw.js')
  ).toBeNull()
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

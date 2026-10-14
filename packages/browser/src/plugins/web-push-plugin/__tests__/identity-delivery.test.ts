import { Analytics } from '../../../core/analytics'
import { Context } from '../../../core/context'
import { customerio } from '../../customerio'
import { acceptDevice, deviceAccepted } from '../../customerio/device-delivery'
import { fetch } from '../../../lib/fetch'
import { scheduleFlush } from '../../customerio/schedule-flush'
import { WebPushPlugin } from '..'

jest.mock('../../../lib/fetch', () => ({ fetch: jest.fn() }))
jest.mock('../../customerio/schedule-flush')

const endpoint = 'https://push.example/device'
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for re-registration')
}

async function setup(
  batching = false,
  persistent = false,
  userId: string | null = 'alice',
  live = false
) {
  const subscription = {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'key', auth: 'key' } }),
    unsubscribe: jest.fn().mockResolvedValue(true),
  }
  const manager = {
    getSubscription: jest.fn().mockResolvedValue(live ? subscription : null),
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
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: jest.fn().mockResolvedValue(registration),
      register: jest.fn().mockResolvedValue(registration),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    },
  })
  Object.defineProperty(window, 'PushManager', {
    configurable: true,
    value: function () {},
  })
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: { requestPermission: jest.fn().mockResolvedValue('granted') },
  })
  const analytics = new Analytics(
    { writeKey: 'test' },
    { disableClientPersistence: !persistent }
  )
  analytics.user().id(userId)
  const destination = customerio(analytics, {
    apiKey: 'test',
    ...(batching
      ? { deliveryStrategy: { strategy: 'batching' as const } }
      : {}),
  })
  const plugin = WebPushPlugin({
    vapidPublicKey: btoa(String.fromCharCode(4) + 'a'.repeat(64)),
  })
  await analytics.register(destination, plugin)
  return { analytics, destination, plugin, subscription, manager }
}

beforeEach(() => {
  localStorage.clear()
  jest.mocked(fetch).mockReset()
  jest.mocked(scheduleFlush).mockClear()
})

// reset cleanup runs in the background; let its acknowledgement/save settle
// before the next test replaces fetch and localStorage.
afterEach(() => new Promise((resolve) => setTimeout(resolve, 0)))

test('acceptance bridges separate bundles without leaking into serialized events', () => {
  const ctx = Context.system()
  const before = JSON.stringify(ctx.toJSON())
  acceptDevice(ctx)
  jest.isolateModules(() => {
    // Load a second module instance to model independently built UMD bundles.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const otherBundle = require('../../customerio/device-delivery')
    expect(otherBundle.deviceAccepted(ctx)).toBe(true)
  })
  expect(JSON.stringify(ctx.toJSON())).toBe(before)
})

test('does not mark an in-flight device registered before the HTTP acknowledgement', async () => {
  let accept!: (response: Response) => void
  jest.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        accept = resolve
      })
  )
  const s = await setup()
  const result = s.analytics.webPush!.subscribe()
  await waitFor(() => jest.mocked(fetch).mock.calls.length === 1)
  expect(
    JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
      .registered
  ).toBe(false)
  accept({ ok: true, status: 200 } as Response)
  await result
  expect(
    JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
      .registered
  ).toBeUndefined()
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test.each([
  { delay: 0, relogin: 0, label: 'same second, immediate retry' },
  { delay: 1700, relogin: 0, label: 'same second, delayed retry' },
  { delay: 1700, relogin: 1000, label: 'strictly older delete' },
])(
  'a dropped delete cannot remove the newer registration ($label)',
  async ({ delay, relogin }) => {
    let time = 1700000000200
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => time)
    let lastOrder = 0
    let attached: string | undefined
    let dropped: Context | undefined
    let drop = true
    const requests: any[] = []
    jest.mocked(fetch).mockImplementation(async (_url, options) => {
      const event = JSON.parse(options!.body as string)
      requests.push(event)
      const order = event.context.device.webpush_seq
      if (event.event === 'Device Deleted' && drop) {
        drop = false
        throw new Error('dropped request')
      }
      // Model the shared services contract (seq, then original browser ms).
      if (order >= lastOrder) {
        lastOrder = order
        attached = event.event === 'Device Deleted' ? undefined : event.userId
      }
      return { ok: true, status: 200 } as Response
    })
    const s = await setup()
    const send = s.destination.track!
    s.destination.track = async (ctx) => {
      if (ctx.event.event === 'Device Deleted' && !dropped) dropped = ctx
      return send(ctx)
    }
    await s.analytics.webPush!.subscribe()
    s.manager.getSubscription.mockResolvedValue(s.subscription)
    time += 700
    s.analytics.reset()
    await waitFor(() =>
      requests.some((event) => event.event === 'Device Deleted')
    )
    time += relogin
    await s.analytics.identify('alice')
    expect(deviceAccepted(dropped!)).toBe(false)
    await s.destination.track!(dropped!)
    await waitFor(
      () =>
        requests.filter((event) => event.event === 'Device Created or Updated')
          .length === 2
    )
    expect(requests.map((event) => event.event).filter(Boolean)).toEqual([
      'Device Created or Updated',
      'Device Deleted',
      'Device Deleted',
      'Device Created or Updated',
    ])
    expect(
      requests
        .filter((event) => event.event?.startsWith('Device'))
        .map((event) => event.context.device.webpush_seq)
    ).toEqual([
      1700000000200,
      1700000000900,
      1700000000900,
      Math.max(1700000000901, time),
    ])
    const deletes = requests.filter((event) => event.event === 'Device Deleted')
    expect(deletes[0].context.device).toEqual(deletes[1].context.device)
    expect(deletes[0].context.device.webpush_event_ms).toBe(1700000000900)
    expect(dropped).toBeDefined()
    expect(deviceAccepted(dropped!)).toBe(true)
    const deletedAt = requests.find(
      (event) => event.event === 'Device Deleted'
    ).timestamp
    const createdAt = requests[requests.length - 1].timestamp
    const deleteSeconds = Math.floor(new Date(deletedAt).getTime() / 1000)
    const createSeconds = Math.floor(new Date(createdAt).getTime() / 1000)
    if (relogin) expect(deleteSeconds).toBeLessThan(createSeconds)
    else expect(deleteSeconds).toBe(createSeconds)
    time += delay
    // Use the same Context retained by the destination retry queue, just as its
    // scheduled flush does; do not construct a new event for the retry.
    await s.destination.track!(dropped!)
    expect(requests[requests.length - 1].timestamp).toBe(deletedAt)
    expect(attached).toBe('alice')
    expect(
      JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!).userId
    ).toBe('alice')
    clock.mockRestore()
    await s.plugin.unload?.(Context.system(), s.analytics)
  }
)

test('same-second logout detaches Alice before Bob registers with a higher sequence', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1700000000200)
  let attached: string | undefined
  const states: (string | undefined)[] = []
  const events: any[] = []
  jest.mocked(fetch).mockImplementation(async (_url, options) => {
    const event = JSON.parse(options!.body as string)
    if (event.event?.startsWith('Device')) {
      events.push(event)
      attached = event.event === 'Device Deleted' ? undefined : event.userId
      states.push(attached)
    }
    return { ok: true, status: 200 } as Response
  })
  const s = await setup()
  await s.analytics.webPush!.subscribe()
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  s.analytics.reset()
  await waitFor(() => events.length === 2)
  await s.analytics.identify('bob')
  await waitFor(() => events.length === 3)
  expect(states).toEqual(['alice', undefined, 'bob'])
  expect(events.map((event) => event.context.device.webpush_seq)).toEqual([
    1700000000200, 1700000000201, 1700000000202,
  ])
  expect(events.map((event) => event.context.device.webpush_event_ms)).toEqual([
    1700000000200, 1700000000200, 1700000000200,
  ])
  await s.plugin.unload?.(Context.system(), s.analytics)
  clock.mockRestore()
})

test.each([false, true])(
  'failed logout reload retries original delete without an identity (live subscription=%s)',
  async (live) => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1700000000200)
    jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
    const s = await setup()
    await s.analytics.webPush!.subscribe()
    jest.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response)
    s.analytics.reset()
    await waitFor(
      () =>
        !!JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
          .pendingDelete
    )
    await waitFor(() => jest.mocked(fetch).mock.calls.length === 2)
    const failed = JSON.parse(
      jest.mocked(fetch).mock.calls[1][1]!.body as string
    )
    await s.plugin.unload?.(Context.system(), s.analytics)
    clock.mockReturnValue(1700000090000)
    jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
    const reloaded = await setup(false, false, null, live)
    await waitFor(() => jest.mocked(fetch).mock.calls.length === 3)
    const retried = JSON.parse(
      jest.mocked(fetch).mock.calls[2][1]!.body as string
    )
    expect(retried.event).toBe('Device Deleted')
    expect(retried.userId).toBe('alice')
    expect(retried.anonymousId).toBeNull()
    expect(retried.context.device).toEqual(failed.context.device)
    expect(retried.timestamp).toBe(failed.timestamp)
    expect(retried.context.device).toMatchObject({
      webpush_event_ms: 1700000000200,
      webpush_seq: 1700000000201,
    })
    await waitFor(
      () =>
        !JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
          .pendingDelete
    )
    await reloaded.analytics.identify('bob')
    await reloaded.analytics.webPush!.subscribe()
    const created = JSON.parse(
      jest
        .mocked(fetch)
        .mock.calls.filter(
          ([, options]) =>
            JSON.parse(options!.body as string).event ===
            'Device Created or Updated'
        )
        .pop()![1]!.body as string
    )
    expect(created.context.device.webpush_seq).toBeGreaterThan(
      failed.context.device.webpush_seq
    )
    await reloaded.plugin.unload?.(Context.system(), reloaded.analytics)
    clock.mockRestore()
  }
)

test.each([false, true])(
  'failed Created is cancelled by logout, including a same-millisecond delete (persistent=%s)',
  async (persistent) => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1700000000200)
    jest
      .mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
    const s = await setup(false, persistent)
    let created!: Context
    const send = s.destination.track!
    s.destination.track = async (ctx) => {
      if (ctx.event.event === 'Device Created or Updated') created = ctx
      return send(ctx)
    }
    await expect(s.analytics.webPush!.subscribe()).rejects.toThrow(
      'not accepted'
    )
    const buffer = jest.mocked(scheduleFlush).mock.calls[0][1]
    expect(buffer.todo).toBe(1)
    // Cover the analytics retry queue as well as the destination retry queue.
    const flush = jest.spyOn(s.analytics.queue, 'emit')
    const coreCreated = new Context(created.event, 'core-queued-create')
    s.analytics.queue.queue.maxAttempts = 4
    const queued = s.analytics.queue.dispatch(coreCreated)
    expect(s.analytics.queue.queue.pop()).toBe(coreCreated)
    expect(s.analytics.queue.queue.pushWithBackoff(coreCreated)).toBe(true)
    expect(s.analytics.queue.queue.includes(coreCreated)).toBe(true)
    jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
    s.analytics.reset()
    await waitFor(() => jest.mocked(fetch).mock.calls.length === 2)
    expect(
      JSON.parse(jest.mocked(fetch).mock.calls[1][1]!.body as string).event
    ).toBe('Device Deleted')
    expect(buffer.todo).toBe(0)
    expect(s.analytics.queue.queue.includes(coreCreated)).toBe(false)
    expect(flush).toHaveBeenCalledWith('flush', coreCreated, false)
    await expect(queued).resolves.toBe(coreCreated)
    await send(created)
    expect(jest.mocked(fetch)).toHaveBeenCalledTimes(2)

    if (persistent) {
      // Model an old pagehide listener re-persisting its copy after logout.
      localStorage.setItem(
        'persisted-queue:v1:dest-Customer.io-Data-Pipelines:items',
        JSON.stringify([created.toJSON()])
      )
      await s.plugin.unload?.(Context.system(), s.analytics)
      jest.mocked(scheduleFlush).mockClear()
      const reload = await setup(false, true)
      const reloadedBuffer = jest.mocked(scheduleFlush).mock.calls[0][1]
      const restored = reloadedBuffer.pop()!
      expect(restored.event.timestamp).toBe(
        JSON.parse(JSON.stringify(created.event.timestamp))
      )
      await reload.destination.track!(restored)
      expect(jest.mocked(fetch)).toHaveBeenCalledTimes(2)
      await reload.plugin.unload?.(Context.system(), reload.analytics)
    } else {
      await s.plugin.unload?.(Context.system(), s.analytics)
    }
    clock.mockRestore()
  }
)

test('a persisted Delete retains its timestamp across a real queue reload', async () => {
  let time = 1700000000900
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => time)
  jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
  const listeners = jest.spyOn(window, 'addEventListener')
  const start = listeners.mock.calls.length
  const s = await setup(false, true)
  await s.analytics.webPush!.subscribe()
  time += 1000
  jest
    .mocked(fetch)
    .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
  s.analytics.reset()
  await waitFor(() => jest.mocked(scheduleFlush).mock.calls.length > 0)
  const original = JSON.parse(
    jest.mocked(fetch).mock.calls[1][1]!.body as string
  )
  for (const [type, listener] of listeners.mock.calls.slice(start)) {
    if (type === 'pagehide')
      (listener as (event: PageTransitionEvent) => void)(
        new PageTransitionEvent('pagehide', { persisted: false })
      )
  }
  await s.plugin.unload?.(Context.system(), s.analytics)
  jest.mocked(scheduleFlush).mockClear()
  time += 5000
  const reload = await setup(false, true)
  const buffer = jest.mocked(scheduleFlush).mock.calls[0][1]
  const restored = buffer.pop()!
  expect(restored.event.event).toBe('Device Deleted')
  expect(restored.event.timestamp).toBe(original.timestamp)
  await reload.destination.track!(restored)
  const retried = JSON.parse(
    jest.mocked(fetch).mock.calls[2][1]!.body as string
  )
  expect(retried.timestamp).toBe(original.timestamp)
  await reload.plugin.unload?.(Context.system(), reload.analytics)
  listeners.mockRestore()
  clock.mockRestore()
})

test('identify and bfcache restore do not warn when push is unsupported', async () => {
  const s = await setup()
  // Model ordinary iOS Safari with service workers but without PushManager.
  Reflect.deleteProperty(window, 'PushManager')
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  await s.analytics.identify('bob')
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(warn).not.toHaveBeenCalled()
  await s.plugin.unload?.(Context.system(), s.analytics)
  warn.mockRestore()
})

test.each([false, true])(
  'device lifecycle requests always use keepalive (batching=%s)',
  async (batching) => {
    jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
    const s = await setup(batching)
    await s.analytics.webPush!.subscribe()
    s.analytics.reset()
    await waitFor(() => jest.mocked(fetch).mock.calls.length === 2)
    expect(
      jest.mocked(fetch).mock.calls.map(([, options]) => options!.keepalive)
    ).toEqual([true, true])
    await s.plugin.unload?.(Context.system(), s.analytics)
  }
)

test('sequence survives clearing all storage after logout and reloading as the same user', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1700000000000)
  jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
  const s = await setup()
  await s.analytics.webPush!.subscribe()
  s.analytics.reset()
  await waitFor(() => jest.mocked(fetch).mock.calls.length === 2)
  const deleted = JSON.parse(
    jest.mocked(fetch).mock.calls[1][1]!.body as string
  )
  await s.plugin.unload?.(Context.system(), s.analytics)
  localStorage.clear()
  clock.mockReturnValue(1700000001000)
  const reloaded = await setup()
  await reloaded.analytics.webPush!.subscribe()
  const created = JSON.parse(
    jest.mocked(fetch).mock.calls[2][1]!.body as string
  )
  expect(created.userId).toBe('alice')
  expect(created.context.device.webpush_seq).toBeGreaterThan(
    deleted.context.device.webpush_seq
  )
  expect(Number.isSafeInteger(created.context.device.webpush_seq)).toBe(true)
  await reloaded.plugin.unload?.(Context.system(), reloaded.analytics)
  clock.mockRestore()
})

test.each([400, 401, 403, 413])(
  'terminal delete HTTP %s clears persisted cleanup and permits registration',
  async (status) => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1700000000000)
    localStorage.setItem(
      'cio-webpush:/cio-webpush-sw.js',
      JSON.stringify({
        endpoint,
        userId: 'alice',
        pendingDelete: { webpush_seq: 5, webpush_event_ms: Date.now() },
      })
    )
    jest.mocked(fetch).mockImplementation(async (_url, options) => {
      const event = JSON.parse(options!.body as string)
      return {
        ok: event.event !== 'Device Deleted',
        status: event.event === 'Device Deleted' ? status : 200,
      } as Response
    })
    const s = await setup(false, true, 'bob', true)
    await waitFor(
      () =>
        JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
          .userId === 'bob'
    )
    expect(
      JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
        .pendingDelete
    ).toBeUndefined()
    expect(
      jest.mocked(scheduleFlush).mock.calls.flatMap(([, buffer]) => buffer.todo)
    ).not.toContain(1)
    await s.plugin.unload?.(Context.system(), s.analytics)
    const reloaded = await setup(false, true, 'bob', true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const deletes = jest
      .mocked(fetch)
      .mock.calls.filter(
        ([, options]) =>
          JSON.parse(options!.body as string).event === 'Device Deleted'
      )
    expect(deletes).toHaveLength(1)
    await reloaded.plugin.unload?.(Context.system(), reloaded.analytics)
    clock.mockRestore()
  }
)

test('offline Bob registers when the buffered logout delete succeeds without reload or another identify', async () => {
  jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
  const s = await setup(false, true)
  await s.analytics.webPush!.subscribe()
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  jest.mocked(fetch).mockRejectedValue(new Error('offline'))
  s.analytics.reset()
  await waitFor(() => jest.mocked(scheduleFlush).mock.calls.length > 0)
  await s.analytics.identify('bob')
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(
    JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!).userId
  ).toBe('alice')
  const buffer = jest.mocked(scheduleFlush).mock.calls[0][1]
  // Flush the actual Context in the destination buffer, as scheduleFlush does.
  const deletion = buffer.pop()!
  expect(deletion.event.event).toBe('Device Deleted')
  jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
  await s.destination.track!(deletion)
  await waitFor(
    () =>
      JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
        .userId === 'bob'
  )
  const events = jest
    .mocked(fetch)
    .mock.calls.map(([, options]) => JSON.parse(options!.body as string))
  expect(
    events.filter((event) => event.event === 'Device Created or Updated').pop()
      .userId
  ).toBe('bob')
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test('an offline short-circuited logout retries on its timer and registers Bob without reload', async () => {
  jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
  const s = await setup()
  await s.analytics.webPush!.subscribe()
  s.manager.getSubscription.mockResolvedValue(s.subscription)
  const timers = jest.spyOn(window, 'setTimeout')
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value: false,
  })
  s.analytics.reset()
  await waitFor(
    () =>
      JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
        .pendingDelete?.attempts === 1
  )
  await s.analytics.identify('bob')
  expect(jest.mocked(fetch)).toHaveBeenCalledTimes(1)
  const pending = JSON.parse(
    localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!
  ).pendingDelete
  const clock = jest.spyOn(Date, 'now').mockReturnValue(pending.nextAttempt)
  Reflect.deleteProperty(navigator, 'onLine')
  // Invoke the scheduled retry at its due time, without waiting 30 real seconds.
  const retry = timers.mock.calls
    .filter(([, delay]) => delay === 30000)
    .pop()![0]
  expect(typeof retry).toBe('function')
  ;(retry as () => void)()
  await waitFor(() => {
    const record = JSON.parse(
      localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!
    )
    return record.userId === 'bob' && record.registered !== false
  })
  expect(
    jest
      .mocked(fetch)
      .mock.calls.map(
        ([, options]) => JSON.parse(options!.body as string).event
      )
  ).toEqual([
    'Device Created or Updated',
    'Device Deleted',
    'Device Created or Updated',
  ])
  await s.plugin.unload?.(Context.system(), s.analytics)
  timers.mockRestore()
  clock.mockRestore()
})

test('two plugin instances serialize sequence allocation using the shared Web Lock', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1700000000000)
  let tail = Promise.resolve() as Promise<unknown>
  const request = jest.fn((_name, callback) => {
    const result = tail.then(() => callback())
    tail = result.catch(() => {})
    return result
  })
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request },
  })
  jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
  const a = await setup()
  const b = await setup()
  await Promise.all([
    a.analytics.webPush!.subscribe(),
    b.analytics.webPush!.subscribe(),
  ])
  const seqs = jest
    .mocked(fetch)
    .mock.calls.map(
      ([, options]) =>
        JSON.parse(options!.body as string).context.device.webpush_seq
    )
  expect(seqs.sort()).toEqual([1700000000000, 1700000000001])
  expect(request).toHaveBeenCalledTimes(2)
  expect(
    request.mock.calls.every(([name]) => name === `cio-webpush:${endpoint}`)
  ).toBe(true)
  await a.plugin.unload?.(Context.system(), a.analytics)
  await b.plugin.unload?.(Context.system(), b.analytics)
  Reflect.deleteProperty(navigator, 'locks')
  clock.mockRestore()
})

test.each([408, 429, 503])(
  'pending delete HTTP %s is not duplicated by reloads or identify during backoff',
  async (status) => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1700000000000)
    jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
    const s = await setup()
    await s.analytics.webPush!.subscribe()
    jest.mocked(fetch).mockResolvedValue({ ok: false, status } as Response)
    s.analytics.reset()
    await waitFor(
      () =>
        !!JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
          .pendingDelete?.attempts
    )
    await s.plugin.unload?.(Context.system(), s.analytics)
    for (let i = 0; i < 3; i++) {
      const reload = await setup(false, false, null, true)
      await reload.analytics.identify('bob')
      await expect(reload.analytics.webPush!.subscribe()).rejects.toThrow(
        'backoff'
      )
      await reload.plugin.unload?.(Context.system(), reload.analytics)
    }
    expect(
      jest
        .mocked(fetch)
        .mock.calls.filter(
          ([, options]) =>
            JSON.parse(options!.body as string).event === 'Device Deleted'
        )
    ).toHaveLength(1)
    clock.mockReturnValue(1700000030000)
    jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
    const recovered = await setup(false, false, 'bob', true)
    await waitFor(
      () =>
        JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
          .userId === 'bob'
    )
    await recovered.plugin.unload?.(Context.system(), recovered.analytics)
    clock.mockRestore()
  }
)

test('the retry timer enforces the attempt cap and releases Bob after a failed final attempt', async () => {
  localStorage.setItem(
    'cio-webpush:/cio-webpush-sw.js',
    JSON.stringify({
      endpoint,
      userId: 'alice',
      pendingDelete: {
        webpush_seq: 5,
        webpush_event_ms: Date.now(),
        attempts: 19,
        nextAttempt: Date.now() + 200,
      },
    })
  )
  jest.mocked(fetch).mockImplementation(async (_url, options) => {
    const deleted =
      JSON.parse(options!.body as string).event === 'Device Deleted'
    return { ok: !deleted, status: deleted ? 503 : 200 } as Response
  })
  const s = await setup(false, false, 'bob', true)
  expect(jest.mocked(fetch)).not.toHaveBeenCalled()
  await waitFor(() => {
    const record = JSON.parse(
      localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!
    )
    return record.userId === 'bob' && record.registered !== false
  })
  expect(
    jest
      .mocked(fetch)
      .mock.calls.map(
        ([, options]) => JSON.parse(options!.body as string).event
      )
  ).toEqual(['Device Deleted', 'Device Created or Updated'])
  await s.plugin.unload?.(Context.system(), s.analytics)
})

test.each(['age', 'attempts'])(
  'pending delete is bounded by %s even if its next attempt is in the future',
  async (bound) => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1700000000000)
    localStorage.setItem(
      'cio-webpush:/cio-webpush-sw.js',
      JSON.stringify({
        endpoint,
        userId: 'alice',
        pendingDelete: {
          webpush_seq: 5,
          webpush_event_ms: Date.now() - (bound === 'age' ? 7 * 86400000 : 0),
          attempts: bound === 'attempts' ? 20 : 1,
          nextAttempt: Date.now() + 3600000,
        },
      })
    )
    jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
    const s = await setup(false, false, 'bob', true)
    await waitFor(
      () =>
        JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
          .userId === 'bob'
    )
    expect(
      jest
        .mocked(fetch)
        .mock.calls.map(
          ([, options]) => JSON.parse(options!.body as string).event
        )
    ).toEqual(['Device Created or Updated'])
    await s.plugin.unload?.(Context.system(), s.analytics)
    clock.mockRestore()
  }
)

test.each([false, true])(
  'HTTP 500 is not registration acceptance (batching=%s)',
  async (batching) => {
    jest
      .mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
    const s = await setup(batching)
    await expect(s.analytics.webPush!.subscribe()).rejects.toThrow(
      'not accepted'
    )
    expect(
      JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
        .registered
    ).toBe(false)
    expect(jest.mocked(fetch).mock.calls[0][0]).toBe(
      'https://cdp.customer.io/v1/t'
    )
    jest.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response)
    await s.analytics.webPush!.subscribe()
    expect(
      JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!)
        .registered
    ).toBeUndefined()
    await s.plugin.unload?.(Context.system(), s.analytics)
  }
)

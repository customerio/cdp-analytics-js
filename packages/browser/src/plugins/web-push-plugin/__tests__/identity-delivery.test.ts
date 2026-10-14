import { Analytics } from '../../../core/analytics'
import { Context } from '../../../core/context'
import { customerio } from '../../customerio'
import { acceptDevice, deviceAccepted } from '../../customerio/device-delivery'
import { fetch } from '../../../lib/fetch'
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

async function setup(batching = false) {
  const subscription = {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'key', auth: 'key' } }),
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
    { disableClientPersistence: true }
  )
  analytics.user().id('alice')
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
})

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

test.each([0, 1700])(
  'a dropped delete retried %i ms after re-login cannot remove the newer registration',
  async (delay) => {
    let time = 1700000000200
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => time)
    let lastUsed: number | undefined
    let dropped: Context | undefined
    let drop = true
    const requests: any[] = []
    jest.mocked(fetch).mockImplementation(async (_url, options) => {
      const event = JSON.parse(options!.body as string)
      requests.push(event)
      const seconds = Math.floor(new Date(event.timestamp).getTime() / 1000)
      if (event.event === 'Device Deleted' && drop) {
        drop = false
        throw new Error('dropped request')
      }
      // FIX-services-delivery contract: whole seconds; a tied/older delete is stale.
      if (event.event === 'Device Created or Updated') lastUsed = seconds
      if (event.event === 'Device Deleted' && seconds > (lastUsed ?? 0))
        lastUsed = undefined
      return { ok: true, status: 200 } as Response
    })
    const s = await setup()
    const send = s.destination.track!
    s.destination.track = async (ctx) => {
      if (ctx.event.event === 'Device Deleted') dropped = ctx
      return send(ctx)
    }
    await s.analytics.webPush!.subscribe()
    s.manager.getSubscription.mockResolvedValue(s.subscription)
    time += delay === 0 ? 0 : 1000
    s.analytics.reset()
    await s.analytics.identify('alice')
    await waitFor(
      () =>
        requests.filter((event) => event.event === 'Device Created or Updated')
          .length === 2
    )
    expect(requests.map((event) => event.event).filter(Boolean)).toEqual([
      'Device Created or Updated',
      'Device Deleted',
      'Device Created or Updated',
    ])
    expect(dropped).toBeDefined()
    expect(deviceAccepted(dropped!)).toBe(false)
    const deletedAt = requests.find(
      (event) => event.event === 'Device Deleted'
    ).timestamp
    time += delay
    // Use the same Context retained by the destination retry queue, just as its
    // scheduled flush does; do not construct a new event for the retry.
    await s.destination.track!(dropped!)
    expect(requests[requests.length - 1].timestamp).toBe(deletedAt)
    expect(lastUsed).toBeDefined()
    expect(
      JSON.parse(localStorage.getItem('cio-webpush:/cio-webpush-sw.js')!).userId
    ).toBe('alice')
    clock.mockRestore()
    await s.plugin.unload?.(Context.system(), s.analytics)
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

import jsdom, { JSDOM } from 'jsdom'
import { InitOptions, getGlobalAnalytics } from '../../'
import { AnalyticsBrowser, loadLegacySettings } from '../../browser'
import { snippet } from '../../tester/__fixtures__/snippet'
import { install } from '../standalone-analytics'
import unfetch from 'unfetch'
import { PersistedPriorityQueue } from '../../lib/priority-queue/persisted'
import { sleep } from '../../lib/sleep'
import * as Factory from '../../test-helpers/factories'
import { EventQueue } from '../../core/queue/event-queue'
import { AnalyticsStandalone } from '../standalone-interface'

const track = jest.fn()
const identify = jest.fn()
const page = jest.fn()
const setAnonymousId = jest.fn()
const register = jest.fn()
const addSourceMiddleware = jest.fn()
const on = jest.fn()

jest.mock('../../core/analytics', () => ({
  Analytics: (_: unknown, options?: InitOptions): unknown => ({
    track,
    identify,
    page,
    setAnonymousId,
    addSourceMiddleware,
    register,
    emit: jest.fn(),
    on,
    queue: new EventQueue(new PersistedPriorityQueue(1, 'event-queue') as any),
    options,
  }),
}))

const fetchSettings = Factory.createSuccess({ integrations: {} })

jest.mock('unfetch', () => {
  return jest.fn()
})

describe('standalone bundle', () => {
  const mockObj = `foo`

  beforeEach(async () => {
    ;(window as any).analytics = undefined
    const html = `
    <!DOCTYPE html>
      <head>
        <script>
          ${snippet(
            mockObj,
            true,
            `
            window.analytics.track('fruit basket', { fruits: ['🍌', '🍇'] })
            window.analytics.setAnonymousId('anonNetto')
            window.analytics.on('initialize', () => ({ user: 'ariel' }))
          `
          )}
        </script>
      </head>
      <body>
      </body>
    </html>
    `.trim()

    const virtualConsole = new jsdom.VirtualConsole()
    const jsd = new JSDOM(html, {
      runScripts: 'dangerously',
      resources: 'usable',
      url: 'http://localhost:3000',
      virtualConsole,
    })

    const windowSpy = jest.spyOn(global, 'window', 'get')
    const documentSpy = jest.spyOn(global, 'document', 'get')

    jest.spyOn(console, 'warn').mockImplementationOnce(() => {})
    jest.spyOn(console, 'error').mockImplementationOnce(() => {})

    windowSpy.mockImplementation(() => {
      return jsd.window as unknown as Window & typeof globalThis
    })

    documentSpy.mockImplementation(
      () => jsd.window.document as unknown as Document
    )
  })

  it('detects embedded write keys', async () => {
    window.analyticsWriteKey = 'write_key_abc_123'

    const fakeAjs = {
      ready: async (cb: Function): Promise<void> => {
        cb()
      },
    }

    const spy = jest
      .spyOn(AnalyticsBrowser, 'standalone')
      .mockResolvedValueOnce(fakeAjs as AnalyticsStandalone)

    await install()

    expect(spy).toHaveBeenCalledWith('write_key_abc_123', {})
  })

  it('refuses secret sk_ keys without loading', async () => {
    window.analyticsWriteKey = 'sk_us_secret'
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const spy = jest.spyOn(AnalyticsBrowser, 'standalone')

    await install()

    expect(spy).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Use your public key in the browser')
    )
    window.analyticsWriteKey = undefined
  })

  it('derives the write key from scripts on the page', async () => {
    const fakeAjs = {
      ready: async (cb: Function): Promise<void> => {
        cb()
      },
    }
    const spy = jest
      .spyOn(AnalyticsBrowser, 'standalone')
      .mockResolvedValueOnce(fakeAjs as AnalyticsStandalone)

    await install()

    expect(spy).toHaveBeenCalledWith(mockObj, {})
  })

  it('derives the CDN from scripts on the page', async () => {
    jest
      .mocked(unfetch)
      // @ts-ignore ignore Response required fields
      .mockImplementation((): Promise<Response> => fetchSettings)

    await loadLegacySettings(mockObj)

    expect(unfetch).toHaveBeenCalledWith(
      'https://cdn.foo.com/v1/projects/foo/settings'
    )
  })

  it('is capable of having the CDN overridden', async () => {
    jest
      .mocked(unfetch)
      // @ts-ignore ignore Response required fields
      .mockImplementation((): Promise<Response> => fetchSettings)
    const mockCdn = 'http://my-overridden-cdn.com'

    getGlobalAnalytics()!._cdn = mockCdn
    await loadLegacySettings(mockObj)

    expect(unfetch).toHaveBeenCalledWith(expect.stringContaining(mockCdn))
  })

  it('runs any buffered operations after load', async () => {
    jest
      .mocked(unfetch)
      // @ts-ignore ignore Response required fields
      .mockImplementation((): Promise<Response> => fetchSettings)

    await install()

    await sleep(0)

    expect(track).toHaveBeenCalledWith('fruit basket', {
      fruits: ['🍌', '🍇'],
    })

    expect(page).toHaveBeenCalled()
  })

  it('adds buffered source middleware before other buffered operations', async () => {
    jest
      .mocked(unfetch)
      // @ts-ignore ignore Response required fields
      .mockImplementation((): Promise<Response> => fetchSettings)

    const operations: string[] = []

    addSourceMiddleware.mockImplementationOnce(() =>
      operations.push('addSourceMiddleware')
    )
    page.mockImplementationOnce(() => operations.push('page'))

    await install()

    await sleep(0)

    expect(addSourceMiddleware).toHaveBeenCalled()

    expect(operations).toEqual([
      // should run before page call in the snippet
      'addSourceMiddleware',
      'page',
    ])
  })

  it('sets buffered anonymousId before loading destinations', async () => {
    jest
      .mocked(unfetch)
      // @ts-ignore ignore Response required fields
      .mockImplementation((): Promise<Response> => fetchSettings)

    const operations: string[] = []

    track.mockImplementationOnce(() => operations.push('track'))
    setAnonymousId.mockImplementationOnce(() =>
      operations.push('setAnonymousId')
    )
    register.mockImplementationOnce(() => operations.push('register'))

    await install()

    await sleep(0)

    expect(setAnonymousId).toHaveBeenCalledWith('anonNetto')

    expect(operations).toEqual([
      // should run before any plugin is registered
      'setAnonymousId',
      // should run before any events are sent downstream
      'register',
      // should run after all plugins have been registered
      'track',
    ])
  })
  it('sets buffered event emitters before loading destinations', async () => {
    jest
      .mocked(unfetch)
      .mockImplementation(() => fetchSettings as Promise<Response>)

    const operations: string[] = []

    track.mockImplementationOnce(() => operations.push('track'))
    on.mockImplementationOnce(() => operations.push('on'))
    register.mockImplementationOnce(() => operations.push('register'))

    await install()

    await sleep(0)

    const initializeCalls = on.mock.calls.filter(
      ([arg1]) => arg1 === 'initialize'
    )

    expect(initializeCalls.length).toBe(1)

    expect(operations).toEqual([
      // should run before any plugin is registered
      'on',
      // should run before any events are sent downstream
      'register',
      // should run after all plugins have been registered
      'track',
    ])
  })

  it('runs any buffered operations created after preFlush after load', async () => {
    jest
      .mocked(unfetch)
      // @ts-ignore ignore Response required fields
      .mockImplementation((): Promise<Response> => fetchSettings)

    // register is called after flushPreBuffer in `loadAnalytics`
    register.mockImplementationOnce(() =>
      getGlobalAnalytics()?.track('race conditions', { foo: 'bar' })
    )

    await install()

    await sleep(0)

    expect(track).toHaveBeenCalledWith('fruit basket', {
      fruits: ['🍌', '🍇'],
    })
    expect(track).toHaveBeenCalledWith('race conditions', { foo: 'bar' })

    expect(page).toHaveBeenCalled()
  })
})

describe('standalone bundle on a Customer.io hosted page', () => {
  const loadOptions: InitOptions = { retryQueue: false }
  const isolated: InitOptions = {
    ...loadOptions,
    disableClientPersistence: true,
  }

  const cases: { name: string; url: string; expected: InitOptions }[] = [
    {
      name: 'the US form host',
      url: 'https://form.customer.io/abc/index.html',
      expected: isolated,
    },
    {
      name: 'a regional form host',
      url: 'https://form-eu.customer.io/abc/index.html',
      expected: isolated,
    },
    {
      name: 'the staging form host',
      url: 'https://form-staging.customer.io/abc/index.html',
      expected: isolated,
    },
    {
      name: "a customer's own site",
      url: 'https://www.example.com/signup',
      expected: loadOptions,
    },
    {
      name: 'another customer.io host',
      url: 'https://fly.customer.io/',
      expected: loadOptions,
    },
    {
      name: 'a subdomain of a form host',
      url: 'https://app.form.customer.io/',
      expected: loadOptions,
    },
    {
      name: 'a host that only starts like a form host',
      url: 'https://form.customer.io.example.com/',
      expected: loadOptions,
    },
  ]

  it.each(cases)('loads with the right storage on $name', async (tc) => {
    const jsd = new JSDOM('<!DOCTYPE html>', { url: tc.url })
    const win = jsd.window as unknown as Window & typeof globalThis
    win.analyticsWriteKey = 'write_key_abc_123'
    ;(win as any).analytics = { _loadOptions: loadOptions }
    jest.spyOn(global, 'window', 'get').mockImplementation(() => win)
    const spy = jest
      .spyOn(AnalyticsBrowser, 'standalone')
      .mockResolvedValueOnce({} as AnalyticsStandalone)

    await install()

    expect(spy).toHaveBeenCalledWith('write_key_abc_123', tc.expected)
  })
})

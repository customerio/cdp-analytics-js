import unfetch from 'unfetch'
import Gist from 'customerio-gist-web'
import { AnalyticsBrowser } from '..'
import { InAppPlugin } from '../../plugins/in-app-plugin'
import { clearBrowserStorage } from '../../test-helpers/browser-storage'
import { createSuccess } from '../../test-helpers/factories'

jest.mock('unfetch')

const inAppPluginName = 'Customer.io In-App Plugin'

// A stand-in for gist-web that follows its rules for a JWT: clearUserToken()
// drops the JWT, and setUserToken() changes nothing while a JWT names the user.
let gistJwt: string | null
let gistCalls: string[]

beforeEach(() => {
  clearBrowserStorage({
    cookieNames: ['ajs_user_id', 'ajs_anonymous_id', 'ajs_group_id'],
  })
  delete (window as any).analytics
  jest.mocked(unfetch).mockImplementation(() =>
    createSuccess({
      integrations: { [inAppPluginName]: { siteId: 'cdn-site-id' } },
    })
  )

  gistJwt = null
  gistCalls = []
  Gist.setup = jest.fn(async () => {
    gistCalls.push('setup')
  })
  Gist.setUserJwt = jest.fn(async (jwt: string | null) => {
    gistCalls.push(`setUserJwt ${jwt}`)
    gistJwt = jwt
  })
  Gist.clearUserToken = jest.fn(async () => {
    gistCalls.push('clearUserToken')
    gistJwt = null
  })
  Gist.setUserToken = jest.fn(async (token: string) => {
    gistCalls.push(`setUserToken ${token}`)
  })
  Gist.setCurrentRoute = jest.fn()
  Gist.setCustomAttribute = jest.fn()
  Gist.clearCustomAttributes = jest.fn()
  Gist.events = {
    on: jest.fn(),
    off: jest.fn(),
    dispatch: jest.fn(),
  } as unknown as typeof Gist.events
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('analytics.setUserJwt', () => {
  it('holds a JWT set while the SDK loads, and gives it to gist-web before setup', async () => {
    const analytics = AnalyticsBrowser.load({ writeKey: 'foo' })
    expect(() => analytics.setUserJwt('t')).not.toThrow()
    await analytics

    expect(gistCalls).toEqual(['setUserJwt t', 'setup'])
    expect(gistJwt).toBe('t')
  })

  it("gives a returning signed-in visitor's JWT to gist-web before setup", async () => {
    const [previousPage] = await AnalyticsBrowser.load({ writeKey: 'foo' })
    await previousPage.identify('bob')
    gistCalls = []

    const analytics = AnalyticsBrowser.load({ writeKey: 'foo' })
    void analytics.setUserJwt('t')
    await analytics

    expect(gistCalls).toEqual(['setUserJwt t', 'setup', 'setUserToken bob'])
    expect(gistJwt).toBe('t')
  })

  it('gives gist-web a JWT that a snippet page buffered before load, before setup', async () => {
    // What the snippet's stub records for cioanalytics.setUserJwt('t'), and for
    // cioanalytics.push(['setUserJwt', 't']) on a snippet without the method.
    ;(window as any).analytics = [['setUserJwt', 't']]

    await AnalyticsBrowser.load({ writeKey: 'foo' })

    expect(gistCalls.slice(0, 2)).toEqual(['setUserJwt t', 'setup'])
  })

  it('keeps the JWT of a visitor who identifies and hands it over while the SDK loads', async () => {
    // Nobody is identified at load, so the plugin's load-time sync would sign
    // gist-web out after the JWT was handed over, and identify() replays later.
    const analytics = AnalyticsBrowser.load({ writeKey: 'foo' })
    const identified = analytics.identify('bob')
    void analytics.setUserJwt('t')
    await analytics
    await identified

    expect(gistJwt).toBe('t')
  })

  it('sends a JWT set after load straight to gist-web, and null clears it', async () => {
    const analytics = AnalyticsBrowser.load({ writeKey: 'foo' })
    const [instance] = await analytics

    await analytics.setUserJwt('x')
    expect(gistJwt).toBe('x')

    instance.setUserJwt(null)
    expect(gistJwt).toBeNull()
  })

  it('keeps a JWT handed over right after reset(), while the SDK loads', async () => {
    const analytics = AnalyticsBrowser.load({ writeKey: 'foo' })
    const reset = analytics.reset()
    const next = analytics.setUserJwt('next')
    await analytics
    await Promise.all([reset, next])

    expect(gistJwt).toBe('next')
  })

  it('keeps a JWT handed over right after reset(), once the SDK has loaded', async () => {
    const [instance] = await AnalyticsBrowser.load({ writeKey: 'foo' })
    instance.setUserJwt('previous')

    instance.reset()
    instance.setUserJwt('next')

    expect(gistJwt).toBe('next')
  })

  it('leaves no JWT when reset() follows setUserJwt while the SDK loads', async () => {
    const analytics = AnalyticsBrowser.load({ writeKey: 'foo' })
    const set = analytics.setUserJwt('a')
    const reset = analytics.reset()
    await analytics
    await Promise.all([set, reset])

    expect(gistJwt).toBeNull()
  })

  it('keeps the last JWT when a reset() falls between two of them while the SDK loads', async () => {
    const analytics = AnalyticsBrowser.load({ writeKey: 'foo' })
    const calls = [
      analytics.setUserJwt('a'),
      analytics.reset(),
      analytics.setUserJwt('b'),
    ]
    await analytics
    await Promise.all(calls)

    expect(gistJwt).toBe('b')
  })

  it('leaves no JWT when the page signs out again after handing one over, while the SDK loads', async () => {
    const analytics = AnalyticsBrowser.load({ writeKey: 'foo' })
    const calls = [
      analytics.reset(),
      analytics.setUserJwt('a'),
      analytics.reset(),
    ]
    await analytics
    await Promise.all(calls)

    expect(gistJwt).toBeNull()
  })

  it('holds the JWT on a page whose in-app plugin loads later, and hands it over then', async () => {
    jest
      .mocked(unfetch)
      .mockImplementation(() => createSuccess({ integrations: {} }))
    const analytics = AnalyticsBrowser.load({ writeKey: 'foo' })
    const set = analytics.setUserJwt('a')
    const [instance] = await analytics
    await set

    await instance.register(InAppPlugin({ siteId: 'later-site-id' }))

    expect(gistCalls.slice(0, 2)).toEqual(['setUserJwt a', 'setup'])
  })

  it('drops the JWT it holds for the in-app plugin on reset()', async () => {
    jest
      .mocked(unfetch)
      .mockImplementation(() => createSuccess({ integrations: {} }))
    const analytics = AnalyticsBrowser.load({ writeKey: 'foo' })
    const set = analytics.setUserJwt('a')
    const [instance] = await analytics
    await set

    instance.reset()
    await instance.register(InAppPlugin({ siteId: 'later-site-id' }))

    expect(Gist.setUserJwt).not.toHaveBeenCalled()
  })

  it('keeps the JWT away from gist-web on an embed-only page', async () => {
    // gist-web stores a JWT it gets before setup, and in embed-only mode it
    // ignores the clearUserToken() that sign-out relies on.
    const analytics = AnalyticsBrowser.load(
      { writeKey: 'foo' },
      { integrations: { [inAppPluginName]: { embedOnly: true } } }
    )
    void analytics.setUserJwt('t')
    const [instance] = await analytics
    instance.setUserJwt('u')

    expect(Gist.setup).toHaveBeenCalledWith(
      expect.objectContaining({ embedOnly: true })
    )
    expect(Gist.setUserJwt).not.toHaveBeenCalled()
  })

  it("loads, logging each hand-over, when the page's gist-web has no setUserJwt", async () => {
    // An older gist-web that loaded first wins window.Gist.
    ;(Gist as any).setUserJwt = undefined
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {})

    const analytics = AnalyticsBrowser.load({ writeKey: 'foo' })
    void analytics.setUserJwt('t')
    const [instance] = await analytics
    instance.setUserJwt('u')

    expect(
      instance.queue.plugins.find((p) => p.name === inAppPluginName)
    ).toBeDefined()
    expect(Gist.setup).toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledTimes(2)
    for (const [message] of consoleError.mock.calls) {
      expect(message).toContain('Failed to hand over the user JWT')
    }
  })
})

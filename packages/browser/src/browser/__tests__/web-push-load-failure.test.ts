import unfetch from 'unfetch'
import { AnalyticsBrowser } from '..'
import { createSuccess } from '../../test-helpers/factories'

jest.mock('unfetch')
jest.mock('../../plugins/web-push-plugin', () => {
  if (mockFailure === 'import') throw new Error('Chunk load failed')
  return {
    WebPushPlugin: () => {
      throw new Error('Plugin construction failed')
    },
  }
})
let mockFailure = 'import'

beforeEach(() => {
  localStorage.clear()
  jest
    .mocked(unfetch)
    .mockImplementation(() => createSuccess({ integrations: {} }))
})
afterEach(() => jest.restoreAllMocks())

test.each(['import', 'construction'])(
  '%s failure skips only web push and keeps track/identify/page working',
  async (failure) => {
    mockFailure = failure
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const [analytics] = await AnalyticsBrowser.load(
      { writeKey: 'foo' },
      {
        integrations: {
          'Customer.io Web Push Plugin': { vapidPublicKey: 'key' },
        },
      }
    )
    expect(analytics.webPush).toBeUndefined()
    expect(analytics.queue.plugins.map((plugin) => plugin.name)).not.toContain(
      'Customer.io Web Push Plugin'
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'Customer.io web push plugin failed to load:',
      expect.any(Error)
    )
    const track = await analytics.track('Still working')
    const identify = await analytics.identify('person')
    const page = await analytics.page('Home')
    expect(track.event).toMatchObject({ type: 'track', event: 'Still working' })
    expect(identify.event).toMatchObject({ type: 'identify', userId: 'person' })
    expect(page.event).toMatchObject({ type: 'page', name: 'Home' })
    expect(track.failedDelivery()).toBeUndefined()
    expect(identify.failedDelivery()).toBeUndefined()
    expect(page.failedDelivery()).toBeUndefined()
    for (const [path, type] of [
      ['t', 'track'],
      ['i', 'identify'],
      ['p', 'page'],
    ]) {
      expect(jest.mocked(unfetch)).toHaveBeenCalledWith(
        `https://cdp.customer.io/v1/${path}`,
        expect.objectContaining({
          method: 'post',
          body: expect.stringContaining(`"type":"${type}"`),
        })
      )
    }
  }
)

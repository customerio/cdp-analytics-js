import unfetch from 'unfetch'
import { AnalyticsBrowser } from '..'
import { createSuccess } from '../../test-helpers/factories'

jest.mock('unfetch')
const name = 'Customer.io Web Push Plugin'

beforeEach(() => {
  localStorage.clear()
  jest
    .mocked(unfetch)
    .mockImplementation(() => createSuccess({ integrations: {} }))
})

test('web push is absent by default', async () => {
  const [analytics] = await AnalyticsBrowser.load({ writeKey: 'foo' })
  expect(analytics.webPush).toBeUndefined()
  expect(
    analytics.queue.plugins.find((plugin) => plugin.name === name)
  ).toBeUndefined()
})

test('load options attach the typed webPush API without a remote integration', async () => {
  const [analytics] = await AnalyticsBrowser.load(
    { writeKey: 'foo' },
    {
      integrations: { [name]: { vapidPublicKey: 'public-key' } },
    }
  )
  expect(analytics.webPush).toEqual({
    requestPermission: expect.any(Function),
    subscribe: expect.any(Function),
    unsubscribe: expect.any(Function),
    subscription: expect.any(Function),
  })
  await analytics.deregister(name)
})

test('enabled false overrides remote settings', async () => {
  jest.mocked(unfetch).mockImplementation(() =>
    createSuccess({
      integrations: { [name]: { vapidPublicKey: 'public-key' } },
    })
  )
  const [analytics] = await AnalyticsBrowser.load(
    { writeKey: 'foo' },
    {
      integrations: { [name]: { enabled: false } },
    }
  )
  expect(analytics.webPush).toBeUndefined()
  expect(
    analytics.queue.plugins.find((plugin) => plugin.name === name)
  ).toBeUndefined()
})

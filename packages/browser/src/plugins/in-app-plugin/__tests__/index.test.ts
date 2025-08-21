import { Analytics } from '../../../core/analytics'
import { pageEnrichment } from '../../page-enrichment'
import { CustomerioSettings } from '../../customerio'
import { InAppPlugin, InAppPluginSettings } from '../'

// Mock the global Gist object
declare global {
  interface Window {
    Gist: any
  }
}

describe('Customer.io In-App Plugin', () => {
  let analytics: Analytics
  let gistMessageShown: Function
  let gistMessageAction: Function
  let gistEventDispatched: Function

  beforeEach(async () => {
    if (typeof analytics !== 'undefined') {
      analytics.reset()
    }

    jest.resetAllMocks()
    jest.restoreAllMocks()

    // Mock the global Gist object that will be loaded from CDN
    const mockGist = {
      setup: jest.fn(),
      clearUserToken: jest.fn(),
      setUserToken: jest.fn(),
      setCurrentRoute: jest.fn(),
      events: {
        on: (name: string, cb: Function) => {
          if (name === 'messageShown') {
            gistMessageShown = cb
          } else if (name === 'messageAction') {
            gistMessageAction = cb
          } else if (name === 'eventDispatched') {
            gistEventDispatched = cb
          }
        },
        off: jest.fn(),
      },
    }

    // Set up window.Gist mock
    Object.defineProperty(window, 'Gist', {
      value: mockGist,
      writable: true,
      configurable: true,
    })

    // Mock document.createElement and appendChild for script loading
    const mockScript = {
      src: '',
      async: false,
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
    }

    jest
      .spyOn(document, 'createElement')
      .mockImplementation((tagName: string) => {
        if (tagName === 'script') {
          return mockScript as any
        }
        return jest.requireActual('document').createElement(tagName)
      })

    jest
      .spyOn(document.head, 'appendChild')
      .mockImplementation((element: any) => {
        // Simulate successful script loading
        if (element === mockScript) {
          setTimeout(() => {
            if (mockScript.onload) mockScript.onload()
          }, 0)
        }
        return element
      })

    const options: CustomerioSettings = { apiKey: 'foo' }
    analytics = new Analytics({ writeKey: options.apiKey })

    await analytics.register(
      InAppPlugin({ siteId: 'siteid' } as InAppPluginSettings),
      pageEnrichment
    )

    // Verify Gist was set up during plugin registration
    expect(window.Gist.setup).toBeCalledTimes(1)
  })

  it('should setup gist with defaults', async () => {
    expect(window.Gist.setup).toBeCalledTimes(1)
    expect(window.Gist.setup).toBeCalledWith({
      env: 'prod',
      logging: undefined,
      siteId: 'siteid',
      useAnonymousSession: undefined,
    })
    // We should clear old gist tokens on setup if we're anonymous
    expect(window.Gist.clearUserToken).toBeCalledTimes(1)
  })

  it('should set gist route on page()', async () => {
    await analytics.page('testpage')
    expect(window.Gist.setCurrentRoute).toBeCalledWith('testpage')
  })

  it('should set gist userToken on identify()', async () => {
    await analytics.identify('testuser@customer.io')
    expect(window.Gist.setUserToken).toBeCalledTimes(1)
    expect(window.Gist.setUserToken).toBeCalledWith('testuser@customer.io')
  })

  it('should clear gist userToken on reset()', async () => {
    // Once during setup
    expect(window.Gist.clearUserToken).toBeCalledTimes(1)

    await analytics.identify('testuser@customer.io')
    expect(window.Gist.setUserToken).toBeCalledTimes(1)
    expect(window.Gist.setUserToken).toBeCalledWith('testuser@customer.io')

    await analytics.reset()

    // Once after reset()
    expect(window.Gist.clearUserToken).toBeCalledTimes(2)
  })

  it('should trigger journey event for open', async () => {
    const spy = jest.spyOn(analytics, 'track')
    gistMessageShown({
      properties: {
        gist: {
          campaignId: 'testcampaign',
        },
      },
    })
    expect(spy).toBeCalledWith('Report Delivery Event', {
      deliveryId: 'testcampaign',
      metric: 'opened',
    })
  })

  it('should trigger journey event for non-dismiss click', async () => {
    const spy = jest.spyOn(analytics, 'track')
    gistMessageAction({
      message: {
        properties: {
          messageId: 'a-test-in-app',
          gist: {
            campaignId: 'testcampaign',
          },
        },
      },
      action: 'action value',
      name: 'action name',
    })
    expect(spy).toBeCalledWith('Report Delivery Event', {
      deliveryId: 'testcampaign',
      metric: 'clicked',
      actionName: 'action name',
      actionValue: 'action value',
    })
  })

  it('should not trigger journey event for dismiss click', async () => {
    const spy = jest.spyOn(analytics, 'track')
    gistMessageAction({
      message: {
        properties: {
          messageId: 'a-test-in-app',
          gist: {
            campaignId: 'testcampaign',
          },
        },
      },
      action: 'gist://close',
      name: 'action name',
    })
    expect(spy).toHaveBeenCalledTimes(0)
  })

  it('should trigger journeys event for analytics:track', async () => {
    const spy = jest.spyOn(analytics, 'track')
    gistEventDispatched({
      name: 'analytics:track',
      payload: {
        event: 'test-event',
        properties: {
          attr1: 'val1',
          attr2: 'val2',
        },
      },
    })
    expect(spy).toBeCalledWith(
      'test-event',
      {
        attr1: 'val1',
        attr2: 'val2',
      },
      undefined
    )
  })

  describe('Anonymous', () => {
    it('should trigger content event for open', async () => {
      const spy = jest.spyOn(analytics, 'track')
      gistMessageShown({
        properties: {
          gist: {
            broadcast: {
              broadcastIdInt: 10,
              templateId: 20,
            },
          },
        },
      })
      expect(spy).toBeCalledWith('Report Content Event', {
        actionType: 'viewed_content',
        contentId: 10,
        templateId: 20,
        contentType: 'in_app_content',
      })
    })

    it('should trigger content event for non-dismiss click', async () => {
      const spy = jest.spyOn(analytics, 'track')
      gistMessageAction({
        message: {
          properties: {
            messageId: 'a-test-in-app',
            gist: {
              broadcast: {
                broadcastIdInt: 10,
                templateId: 20,
              },
            },
          },
        },
        action: 'action value',
        name: 'action name',
      })
      expect(spy).toBeCalledWith('Report Content Event', {
        actionType: 'clicked_content',
        contentId: 10,
        templateId: 20,
        contentType: 'in_app_content',
        actionName: 'action name',
        actionValue: 'action value',
      })
    })

    it('should not trigger content event for dismiss click', async () => {
      const spy = jest.spyOn(analytics, 'track')
      gistMessageAction({
        message: {
          properties: {
            messageId: 'a-test-in-app',
            gist: {
              broadcast: {
                broadcastIdInt: 10,
                templateId: 20,
              },
            },
          },
        },
        action: 'gist://close',
        name: 'action name',
      })
      expect(spy).toHaveBeenCalledTimes(0)
    })
  })
})

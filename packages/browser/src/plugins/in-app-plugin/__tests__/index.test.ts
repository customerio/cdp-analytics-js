import { Analytics } from '../../../core/analytics'
import { Plugin } from '../../../core/plugin'
import { pageEnrichment } from '../../page-enrichment'
import { customerio, CustomerioSettings } from '../../customerio'
import { InAppPlugin, InAppPluginSettings } from '../'
import { gistToCIO } from '../events'
import cookie from 'js-cookie'
import Gist from './fake-gist'

jest.mock('unfetch', () => {
  return jest.fn()
})

describe('Customer.io In-App Plugin', () => {
  let options: CustomerioSettings
  let settings: InAppPluginSettings
  let analytics: Analytics
  let inAppPlugin: Plugin
  let cio: Plugin

  beforeEach(async () => {
    jest.resetAllMocks()
    jest.restoreAllMocks()

    options = { apiKey: 'foo' }
    analytics = new Analytics({ writeKey: options.apiKey })
    cio = customerio(analytics, options, {})

    settings = {
        siteId: 'siteid',
        dataCenter: 'US',
    };
    inAppPlugin = InAppPlugin(settings)

    await analytics.register(inAppPlugin, pageEnrichment)

    window.localStorage.clear()

  })

  function resetCookies(): void {
    Object.keys(cookie.get()).map((key) => cookie.remove(key))
  }

  afterEach(async () => {
    analytics.reset()
    resetCookies()

    window.localStorage.clear()
  })

  it('should setup gist with defaults', async () => {
    expect(Gist.setup).toBeCalledTimes(1);
    expect(Gist.setup).toBeCalledWith({"dataCenter": "US", "env": "prod", "logging": undefined, "siteId": "siteid"});
    // We should clear old gist tokens on setup if we're anonymous
    expect(Gist.clearUserToken).toBeCalledTimes(1);
  });

  it('should set gist route on page()', async () => {
    await analytics.page('testpage');
    expect(Gist.setCurrentRoute).toBeCalledWith('testpage');
  });

  it('should set gist userToken on identify()', async () => {
    await analytics.identify('testuser@customer.io');
    expect(Gist.setUserToken).toBeCalledTimes(1);
    expect(Gist.setUserToken).toBeCalledWith('testuser@customer.io');
  });

  it('should clear gist userToken on reset()', async () => {
    // Once during setup
    expect(Gist.clearUserToken).toBeCalledTimes(1);

    await analytics.identify('testuser@customer.io');
    expect(Gist.setUserToken).toBeCalledTimes(1);
    expect(Gist.setUserToken).toBeCalledWith('testuser@customer.io');

    await analytics.reset();

    // Once after reset()
    expect(Gist.clearUserToken).toBeCalledTimes(2);
  });

  it('should trigger journey event for open', async () => {
    const spy = jest.spyOn(analytics, 'track');
    Gist.messageShown({
      properties: {
        gist: {
          campaignId: 'testcampaign',
        }
      }
    });
    expect(spy).toBeCalledWith('Journey Delivery Metric', {delivery_id:"testcampaign", metric:"opened"});
  });

  it('should trigger journey event for non-dismiss click', async () => {
    const spy = jest.spyOn(analytics, 'track');
    Gist.messageAction({
      message: {
        properties: {
          messageId: "a-test-in-app",
          gist: {
            campaignId: 'testcampaign',
          }
        },
      },
      action: "action value",
      name: "action name",
    });
    expect(spy).toBeCalledWith('Journey Delivery Metric', {delivery_id:"testcampaign", metric:"clicked", action_name:"action name", action_value:"action value"});
  });

  it('should not trigger journey event for dismiss click', async () => {
    const spy = jest.spyOn(analytics, 'track');
    Gist.messageAction({
      message: {
        properties: {
          messageId: "a-test-in-app",
          gist: {
            campaignId: 'testcampaign',
          }
        },
      },
      action: "gist://close",
      name: "action name",
    });
    expect(spy).toHaveBeenCalledTimes(0);
  });

});
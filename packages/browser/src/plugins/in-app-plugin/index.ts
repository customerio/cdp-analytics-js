import { Analytics } from '../../core/analytics'
import { Context } from '../../core/context'
import { Plugin } from '../../core/plugin'

import {
  InAppEvents,
  JourneysEvents,
  newEvent,
  allEvents,
  gistToCIO,
  ContentType,
} from './events'

// Type declaration for the globally loaded Gist library
declare global {
  interface Window {
    Gist: any
  }
}

// Dynamic loader for Gist from CDN
function loadGistFromCDN(): Promise<any> {
  return new Promise((resolve, reject) => {
    // Check if Gist is already loaded
    if (window.Gist) {
      resolve(window.Gist)
      return
    }

    // Create script tag to load from CDN
    const script = document.createElement('script')
    script.src = 'https://code.gist.build/web/latest/gist.min.js'
    script.async = true

    script.onload = () => {
      if (window.Gist) {
        resolve(window.Gist)
      } else {
        reject(new Error('Gist library failed to load from CDN'))
      }
    }

    script.onerror = () => {
      reject(new Error('Failed to load Gist library from CDN'))
    }

    // Add script to document
    document.head.appendChild(script)
  })
}

export { InAppEvents }

export type InAppPluginSettings = {
  siteId: string | undefined
  events: EventListenerOrEventListenerObject | null | undefined

  _env: string | undefined
  _logging: boolean | undefined

  anonymousInApp: boolean | false
}

export function InAppPlugin(settings: InAppPluginSettings): Plugin {
  let _analytics: Analytics
  let _gist: any = null
  let _gistLoaded = false
  let _pluginLoaded = false
  const _eventTarget: EventTarget = new EventTarget()

  function attachListeners() {
    if (!_gistLoaded || _pluginLoaded) return

    _analytics.on('reset', reset)

    if (settings.events) {
      allEvents.forEach((event) => {
        _eventTarget.addEventListener(
          event,
          settings?.events as EventListenerOrEventListenerObject
        )
      })
      ;['messageDismissed', 'messageError'].forEach((event) => {
        _gist.events.on(event, (message: any) => {
          _eventTarget.dispatchEvent(
            newEvent(gistToCIO(event), {
              messageId: message.messageId,
              deliveryId: message.properties?.gist?.campaignId,
            })
          )
        })
      })
    }

    _gist.events.on('messageShown', (message: any) => {
      const deliveryId: string = message?.properties?.gist?.campaignId
      if (settings.events) {
        _eventTarget.dispatchEvent(
          newEvent(InAppEvents.MessageOpened, {
            messageId: message?.messageId,
            deliveryId: deliveryId,
            message: {
              dismiss: function () {
                _gist.dismissMessage(message?.instanceId)
              },
            },
          })
        )
      }
      if (typeof deliveryId != 'undefined' && deliveryId != '') {
        void _analytics.track(JourneysEvents.Metric, {
          deliveryId: deliveryId,
          metric: JourneysEvents.Opened,
        })
        return
      }
      const broadcastId: Number =
        message?.properties?.gist?.broadcast?.broadcastIdInt
      if (broadcastId) {
        const templateId = message?.properties?.gist?.broadcast?.templateId
        void _analytics.track(JourneysEvents.Content, {
          actionType: JourneysEvents.ViewedContent,
          contentId: broadcastId,
          templateId: templateId,
          contentType: ContentType,
        })
      }
    })

    _gist.events.on('messageAction', (params: any) => {
      const deliveryId: string = params?.message?.properties?.gist?.campaignId
      if (settings.events) {
        _eventTarget.dispatchEvent(
          newEvent(InAppEvents.MessageAction, {
            messageId: params.message.messageId,
            deliveryId: deliveryId,
            action: params.action,
            name: params.name,
            actionName: params.name,
            actionValue: params.action,
            message: {
              dismiss: function () {
                _gist.dismissMessage(params.message.instanceId)
              },
            },
          })
        )
      }
      if (params.action == 'gist://close') {
        return
      }
      if (typeof deliveryId != 'undefined' && deliveryId != '') {
        void _analytics.track(JourneysEvents.Metric, {
          deliveryId: deliveryId,
          metric: JourneysEvents.Clicked,
          actionName: params.name,
          actionValue: params.action,
        })
        return
      }
      const broadcastId: Number =
        params?.message?.properties?.gist?.broadcast?.broadcastIdInt
      if (broadcastId) {
        const templateId: Number =
          params?.message?.properties?.gist?.broadcast?.templateId
        void _analytics.track(JourneysEvents.Content, {
          actionType: JourneysEvents.ClickedContent,
          contentId: broadcastId,
          templateId: templateId,
          contentType: ContentType,
          actionName: params.name,
          actionValue: params.action,
        })
      }
    })

    _gist.events.on('eventDispatched', (gistEvent: any) => {
      if (gistEvent.name == 'analytics:track') {
        const trackEventName: string = gistEvent.payload?.event
        if (typeof trackEventName === 'undefined' || trackEventName == '') {
          return
        }
        void _analytics.track(
          trackEventName,
          gistEvent.payload?.properties,
          gistEvent.payload?.options
        )
      }
    })
  }

  function page(ctx: Context): Promise<Context> {
    if (!_pluginLoaded) return Promise.resolve(ctx)

    const page: string =
      ctx.event?.properties?.name ?? ctx.event?.properties?.url
    if (typeof page === 'string' && page.length > 0) {
      _gist.setCurrentRoute(page)
    }

    return Promise.resolve(ctx)
  }

  async function reset(ctx: Context): Promise<Context> {
    await _gist.clearUserToken()
    return ctx
  }

  async function syncUserToken(ctx: Context): Promise<Context> {
    if (!_gistLoaded) return ctx

    const user = _analytics.user().id()
    if (typeof user === 'string' && user.length > 0) {
      await _gist.setUserToken(user)
    } else {
      await _gist.clearUserToken()
    }
    return ctx
  }

  const customerio: Plugin = {
    name: 'Customer.io In-App Plugin',
    type: 'before',
    version: '0.0.1',
    isLoaded: (): boolean => _pluginLoaded,
    load: async (ctx: Context, instance: Analytics) => {
      _analytics = instance

      if (settings.siteId == null || settings.siteId == '') {
        _error("siteId is required. Can't initialize.")
        return ctx
      }

      try {
        // Load Gist dynamically from CDN
        _gist = await loadGistFromCDN()

        await _gist.setup({
          siteId: settings.siteId,
          env: settings._env ? settings._env : 'prod',
          logging: settings._logging,
          useAnonymousSession: settings.anonymousInApp,
        })
        _gistLoaded = true

        await syncUserToken(ctx)
        attachListeners()

        _pluginLoaded = true
      } catch (error) {
        _error(
          `Failed to load Gist library: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return ctx
      }

      return Promise.resolve()
    },
    identify: syncUserToken,
    page: page,
    unload: () => {
      if (settings.events) {
        allEvents.forEach((event) => {
          _eventTarget.removeEventListener(
            event,
            settings?.events as EventListenerOrEventListenerObject
          )
        })
      }
    },
  }

  return customerio
}

function _error(msg: string) {
  console.error(`[Customer.io In-App Plugin] ${msg}`)
}

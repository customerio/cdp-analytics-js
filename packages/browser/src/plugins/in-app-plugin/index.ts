import { Analytics } from '../../core/analytics'
import { Context } from '../../core/context'
import { Plugin } from '../../core/plugin'
import { hasQueryString } from '../../core/query-string'

import {
  InAppEvents,
  InboxEvents,
  JourneysEvents,
  newEvent,
  allEvents,
  gistToCIO,
  ContentType,
} from './events'
import Gist, { type GistConfig, type ColorScheme } from 'customerio-gist-web'
import type { InboxAPI, InboxMessage, GistInboxMessage, InboxActionConfig, InboxMessageActionParams } from './inbox_messages'
import { createInboxAPI } from './inbox_messages'

export { InAppEvents, InboxEvents }
export type { InboxAPI, InboxMessage, ColorScheme }

export type InAppPluginSettings = {
  siteId?: string
  events?: EventListenerOrEventListenerObject | null

  _env?: GistConfig['env']
  _logging?: GistConfig['logging']

  anonymousInApp?: boolean
  enabled?: boolean
  /**
   * Set by a host that only places embedded messages — a landing-page snippet,
   * typically. The SDK then renders the embeds declared on the page and starts
   * none of the delivery machinery: no user queue, SSE, guest session or inbox.
   * Leave unset for a workspace that also receives in-app messages, so both
   * work on the same page.
   */
  embedOnly?: boolean
  /**
   * Controls the color scheme for in-app messages.
   * - `'default'` — always use light mode
   * - `'system'` — follow the user's OS-level color scheme preference
   * - `'auto'` — detect the color scheme from the page and react to live changes
   *
   * Defaults to `'default'` (light) when not specified.
   */
  colorScheme?: GistConfig['colorScheme']
}

/**
 * The embedded-message surface of the SDK. The plugin and gist-web are separate
 * lazily-loaded chunks that can be paired across versions, so it is detected
 * rather than assumed: an older SDK renders no embeds instead of throwing.
 * Collapses to a direct import once the pinned gist-web includes it.
 */
type GistEmbedSurface = {
  embed?: (payload: unknown) => Promise<string | null>
  mountEmbeds?: () => Promise<string[]>
}

const gistEmbeds = Gist as unknown as GistEmbedSurface

function supportsEmbeds(): boolean {
  return typeof gistEmbeds.mountEmbeds === 'function'
}

// Mirrors the attribute the SDK scans for. Only used to decide whether a
// version mismatch is worth reporting, so a page with no embeds stays quiet.
const EMBED_PAYLOAD_SELECTOR =
  'script[type="application/json"][data-cio-embed-payload]'

function pageDeclaresEmbeds(): boolean {
  return document.querySelector(EMBED_PAYLOAD_SELECTOR) !== null
}

/**
 * Reporting identity for content that belongs to no campaign — an anonymous
 * broadcast, or an embed the page supplied. Both report as the same content
 * event through the same call: the pipeline requires an integer contentId and
 * templateId (services core/batch/batch.go), so an embed payload has to carry
 * them exactly as a broadcast does.
 */
function contentIds(message: any): {
  contentId?: number
  templateId?: number
} {
  const gist = message?.properties?.gist
  const broadcast = gist?.broadcast
  if (broadcast) {
    return {
      contentId: broadcast.broadcastIdInt || broadcast.broadcastId,
      templateId: broadcast.templateId,
    }
  }
  return { contentId: gist?.contentId, templateId: gist?.templateId }
}

// A content event with a missing id is accepted at the edge and dropped by the
// consumer, which is silent from here — so say so rather than let the metric
// simply never appear.
function warnMissingContentIds(
  message: any,
  contentId?: number,
  templateId?: number
): void {
  if (contentId && templateId) return
  const embedId = message?.embedId
  if (embedId) {
    _error(
      `Embedded message ${embedId} carries no contentId/templateId, so its events cannot be reported.`
    )
  } else if (contentId && !templateId) {
    _error(
      `Content event for contentId ${contentId} has no templateId; the pipeline requires both and will drop it.`
    )
  }
}

if (hasQueryString('cio_debug_session', 'true')) {
  Gist.setupDebugOverlay?.()
}

export function InAppPlugin(settings: InAppPluginSettings): Plugin {
  let _analytics: Analytics
  let _gistLoaded = false
  let _pluginLoaded = false
  const _eventTarget: EventTarget = new EventTarget()

  async function setAnonymousId() {
    const anonymousId = _analytics.user().anonymousId()
    if (anonymousId) {
      await Gist.setCustomAttribute('cio_anonymous_id', anonymousId)
    }
  }

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
        Gist.events.on(event, (message: any) => {
          _eventTarget.dispatchEvent(
            newEvent(gistToCIO(event), {
              messageId: message.messageId,
              deliveryId: message.properties?.gist?.campaignId,
              embedId: message.embedId,
            })
          )
        })
      })
    }

    Gist.events.on('messageShown', (message: any) => {
      const deliveryId: string = message?.properties?.gist?.campaignId
      const embedId: string | undefined = message?.embedId
      if (settings.events) {
        _eventTarget.dispatchEvent(
          newEvent(InAppEvents.MessageOpened, {
            messageId: message?.messageId,
            deliveryId: deliveryId,
            embedId: embedId,
            message: {
              dismiss: function () {
                void Gist.dismissMessage(message?.instanceId)
              },
            },
          })
        )
      }
      if (typeof deliveryId !== 'undefined' && deliveryId !== '') {
        void _analytics.track(JourneysEvents.Metric, {
          deliveryId: deliveryId,
          metric: JourneysEvents.Opened,
        })
        return
      }
      const { contentId, templateId } = contentIds(message)
      warnMissingContentIds(message, contentId, templateId)
      if (contentId) {
        void _analytics.track(JourneysEvents.Content, {
          actionType: JourneysEvents.ViewedContent,
          contentId: contentId,
          templateId: templateId,
          contentType: ContentType,
        })
      }
    })

    Gist.events.on('inboxMessageAction', (event: unknown) => {
      const params = event as InboxMessageActionParams
      if (params?.message && params?.action) {
        if (settings.events) {
          const { message, action, actionConfig } = params
          if (action === 'opened') {
            _eventTarget.dispatchEvent(
              newEvent(InboxEvents.MessageOpened, {
                messageId: message.queueId,
                deliveryId: message.deliveryId,
              })
            )
          } else if (action === 'dismissed') {
            _eventTarget.dispatchEvent(
              newEvent(InboxEvents.MessageDismissed, {
                messageId: message.queueId,
                deliveryId: message.deliveryId,
              })
            )
          } else if (action === 'clicked') {
            _eventTarget.dispatchEvent(
              newEvent(InboxEvents.MessageAction, {
                messageId: message.queueId,
                deliveryId: message.deliveryId,
                action: actionConfig?.action,
                name: actionConfig?.name,
                actionName: actionConfig?.name,
                actionValue: actionConfig?.action,
              })
            )
          }
        }

        _handleInboxMessageAction(
          _analytics,
          params.message,
          params.action,
          params.actionConfig
        )
      }
    })

    Gist.events.on('messageAction', (params: any) => {
      const deliveryId: string = params?.message?.properties?.gist?.campaignId
      const embedId: string | undefined = params?.message?.embedId
      if (settings.events) {
        _eventTarget.dispatchEvent(
          newEvent(InAppEvents.MessageAction, {
            messageId: params.message.messageId,
            deliveryId: deliveryId,
            embedId: embedId,
            action: params.action,
            name: params.name,
            actionName: params.name,
            actionValue: params.action,
            message: {
              dismiss: function () {
                void Gist.dismissMessage(params.message.instanceId)
              },
            },
          })
        )
      }
      if (params.action === 'gist://close') {
        return
      }
      if (typeof deliveryId !== 'undefined' && deliveryId !== '') {
        void _analytics.track(JourneysEvents.Metric, {
          deliveryId: deliveryId,
          metric: JourneysEvents.Clicked,
          actionName: params.name,
          actionValue: params.action,
        })
        return
      }
      const { contentId, templateId } = contentIds(params?.message)
      warnMissingContentIds(params?.message, contentId, templateId)
      if (contentId) {
        void _analytics.track(JourneysEvents.Content, {
          actionType: JourneysEvents.ClickedContent,
          contentId: contentId,
          templateId: templateId,
          contentType: ContentType,
          actionName: params.name,
          actionValue: params.action,
        })
      }
    })

    Gist.events.on('eventDispatched', (gistEvent: any) => {
      if (gistEvent.name === 'analytics:track') {
        const trackEventName: string = gistEvent.payload?.event
        if (typeof trackEventName === 'undefined' || trackEventName === '') {
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

  function page(ctx: Context): Context {
    if (!_pluginLoaded) return ctx

    const page: string =
      ctx.event?.properties?.name ?? ctx.event?.properties?.url
    if (typeof page === 'string' && page.length > 0) {
      void Gist.setCurrentRoute(page)
    }

    return ctx
  }

  async function reset(ctx: Context): Promise<Context> {
    await Gist.clearUserToken()
    await Gist.clearCustomAttributes()
    await setAnonymousId()
    return ctx
  }

  async function syncUserToken(ctx: Context): Promise<Context> {
    if (!_gistLoaded) return ctx

    const user = _analytics.user().id()
    if (typeof user === 'string' && user.length > 0) {
      await Gist.setUserToken(user)
    } else {
      await Gist.clearUserToken()
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

      // An embed-only host has no queue to authenticate against, so it can run
      // without a siteId — the workspace supplies one only when in-app
      // messaging is enabled for it.
      if (
        !settings.embedOnly &&
        (settings.siteId == null || settings.siteId === '')
      ) {
        _error("siteId is required. Can't initialize.")
        return ctx
      }

      await setAnonymousId()

      await Gist.setup({
        siteId: settings.siteId ?? '',
        env: settings._env ? settings._env : 'prod',
        logging: settings._logging,
        useAnonymousSession: settings.anonymousInApp,
        colorScheme: settings.colorScheme,
        embedOnly: settings.embedOnly,
      } as GistConfig)
      _gistLoaded = true

      await syncUserToken(ctx)
      attachListeners()
      ;(instance as any).inbox = (...topics: string[]): InboxAPI => {
        if (!_pluginLoaded) {
          throw new Error(
            'Customer.io In-App Plugin is not loaded yet. Ensure the plugin is initialized before calling inbox().'
          )
        }
        return createInboxAPI(instance, Gist, topics)
      }
      ;(instance as any).embed = async (
        payload: unknown
      ): Promise<string | null> => {
        if (!gistEmbeds.embed) {
          _error(
            'Embedded messages are not supported by the loaded in-app SDK.'
          )
          return null
        }
        return gistEmbeds.embed(payload)
      }
      _pluginLoaded = true

      // Embeds are declared in the page's own markup, and mounting is deliberately
      // not awaited: the SDK waits for each container to appear, which must not
      // hold up analytics.load. Listeners are already attached, so the view each
      // embed reports on render is captured.
      if (supportsEmbeds()) {
        // Wrapped rather than assumed to be a promise: feature detection only
        // proves mountEmbeds is a function, and a mismatched SDK must not break
        // plugin load. Caught rather than left floating, because an unhandled
        // rejection on a customer's page surfaces as ours.
        Promise.resolve(gistEmbeds.mountEmbeds?.()).catch((error: unknown) => {
          _error(`Failed to mount embedded messages: ${String(error)}`)
        })
      } else if (pageDeclaresEmbeds()) {
        _error(
          'This page declares embedded messages, but the loaded in-app SDK does not support them.'
        )
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

function _handleInboxMessageAction(
  analyticsInstance: Analytics,
  message: GistInboxMessage,
  action: InboxMessageActionParams['action'],
  actionConfig?: InboxActionConfig
) {
  const deliveryId = message?.deliveryId
  if (typeof deliveryId === 'undefined' || deliveryId === '') {
    return
  }

  if (action === 'opened') {
    void analyticsInstance.track(JourneysEvents.Metric, {
      deliveryId: deliveryId,
      metric: JourneysEvents.Opened,
    })
    return
  }

  if (action === 'clicked') {
    if (actionConfig?.behavior === 'dismiss' && !actionConfig?.name) {
      return
    }
    void analyticsInstance.track(JourneysEvents.Metric, {
      deliveryId: deliveryId,
      metric: JourneysEvents.Clicked,
      actionName: actionConfig?.name,
      actionValue: actionConfig?.action,
    })
  }
}

function _error(msg: string) {
  console.error(`[Customer.io In-App Plugin] ${msg}`)
}

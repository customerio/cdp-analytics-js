import type { Analytics } from '../../core/analytics'
import type { Plugin } from '../../core/plugin'
import { getCDN } from '../../lib/parse-cdn'

export interface WebPushSubscriptionJSON {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

export interface WebPushPluginSettings {
  vapidPublicKey: string
  serviceWorkerUrl?: string
  trackUrl?: string
  enabled?: boolean
}

export interface WebPushAPI {
  requestPermission(): Promise<NotificationPermission>
  subscribe(opts?: {
    vapidPublicKey?: string
    serviceWorkerUrl?: string
  }): Promise<WebPushSubscriptionJSON>
  unsubscribe(): Promise<void>
  subscription(): Promise<WebPushSubscriptionJSON | null>
}

export function urlBase64ToUint8Array(value: string): Uint8Array {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
  const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0))
}

function supported(): void {
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    throw new Error(
      'Web push requires a supported browser on HTTPS or localhost.'
    )
  }
}

function json(subscription: PushSubscription): WebPushSubscriptionJSON {
  const value = subscription.toJSON()
  if (!value.endpoint || !value.keys?.p256dh || !value.keys?.auth) {
    throw new Error('Web push subscription is missing its endpoint or keys.')
  }
  return value as WebPushSubscriptionJSON
}

async function activated(
  registration: ServiceWorkerRegistration
): Promise<void> {
  if (registration.active?.state === 'activated') return
  const worker =
    registration.installing || registration.waiting || registration.active
  if (!worker) throw new Error('Web push service worker is unavailable.')
  await new Promise<void>((resolve, reject) => {
    const changed = () => {
      if (worker.state === 'activated' || worker.state === 'redundant') {
        worker.removeEventListener('statechange', changed)
        if (worker.state === 'activated') resolve()
        else reject(new Error('Web push service worker activation failed.'))
      }
    }
    worker.addEventListener('statechange', changed)
    changed()
  })
}

export function WebPushPlugin(settings: WebPushPluginSettings): Plugin {
  let analytics: Analytics
  let workerUrl = settings.serviceWorkerUrl ?? '/cio-webpush-sw.js'
  const storageKey = () =>
    `cio-webpush:${new URL(workerUrl, location.href).pathname}`
  const stored = (): string | null => {
    try {
      return localStorage.getItem(storageKey())
    } catch {
      return null
    }
  }
  const save = (endpoint: string | null): void => {
    try {
      if (endpoint) localStorage.setItem(storageKey(), endpoint)
      else localStorage.removeItem(storageKey())
    } catch {
      /* Persistence is optional in private browsing. */
    }
  }
  const pending = new Set<(error?: Error) => void>()
  const identified = () => {
    if (analytics.user().id()) pending.forEach((finish) => finish())
  }
  const pagehide = () =>
    pending.forEach((finish) =>
      finish(
        new Error(
          'Web push registration requires analytics.identify(userId) before the page closes.'
        )
      )
    )
  const identity = (): Promise<void> => {
    if (analytics.user().id()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        pending.delete(finish)
        if (error) reject(error)
        else resolve()
      }
      pending.add(finish)
    })
  }
  const registration = async () => {
    supported()
    const found = await navigator.serviceWorker.getRegistration(workerUrl)
    // Do not operate on an unrelated worker that happens to cover this path.
    const worker = found?.active || found?.waiting || found?.installing
    return worker &&
      new URL(worker.scriptURL).pathname ===
        new URL(workerUrl, location.href).pathname
      ? found
      : undefined
  }
  const live = async () =>
    (await registration())?.pushManager.getSubscription() ?? null
  const device = (token: string) => ({
    context: { device: { token, type: 'web' } },
  })
  const registerDevice = async (subscription: PushSubscription) => {
    const value = json(subscription)
    await identity()
    // Identity can have been reset between resolving the queue and this continuation.
    if (!analytics.user().id())
      throw new Error('Web push requires an identified user.')
    await analytics.track(
      'Device Created or Updated',
      {
        webpush_p256dh: value.keys.p256dh,
        webpush_auth: value.keys.auth,
        user_agent: navigator.userAgent,
      },
      device(value.endpoint)
    )
    save(value.endpoint)
    return value
  }
  const reconcile = async (force = false) => {
    const subscription = await live()
    if (subscription && (force || stored() !== subscription.endpoint))
      await registerDevice(subscription)
  }
  const background = (task: Promise<unknown>) => {
    void task.catch((error: unknown) =>
      console.warn('Customer.io web push:', error)
    )
  }
  const message = (event: MessageEvent) => {
    if (event.data?.type === 'cio-webpush-subscriptionchange')
      background(reconcile(true))
  }
  const api: WebPushAPI = {
    requestPermission: async () => {
      supported()
      return Notification.requestPermission()
    },
    subscribe: async (opts = {}) => {
      supported()
      const publicKey = opts.vapidPublicKey ?? settings.vapidPublicKey
      if (!publicKey) throw new Error('Web push requires a vapidPublicKey.')
      const key = urlBase64ToUint8Array(publicKey)
      if (key.length !== 65 || key[0] !== 4)
        throw new Error(
          'VAPID public key must be a 65-byte uncompressed P-256 point.'
        )
      if ((await api.requestPermission()) !== 'granted')
        throw new Error('Notification permission was not granted.')
      workerUrl = opts.serviceWorkerUrl ?? workerUrl
      const trackUrl =
        settings.trackUrl ??
        (getCDN().includes('cdp-eu.customer.io')
          ? 'https://track-eu.customer.io'
          : 'https://track.customer.io')
      const url = new URL(workerUrl, location.href)
      if (url.origin !== location.origin)
        throw new Error('Web push service worker must be same-origin.')
      url.searchParams.set('track', trackUrl)
      const reg = await navigator.serviceWorker.register(
        url.pathname + url.search
      )
      await activated(reg)
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      })
      return registerDevice(subscription)
    },
    unsubscribe: async () => {
      const subscription = await live()
      const token = subscription?.endpoint ?? stored()
      if (!token) return
      await identity()
      if (!analytics.user().id())
        throw new Error('Web push requires an identified user.')
      if (subscription && !(await subscription.unsubscribe()))
        throw new Error('Browser unsubscribe failed.')
      // Retain the token if tracking fails after the browser subscription is gone.
      save(token)
      await analytics.track('Device Deleted', {}, device(token))
      save(null)
    },
    subscription: async () => {
      const subscription = await live()
      return subscription ? json(subscription) : null
    },
  }
  return {
    name: 'Customer.io Web Push Plugin',
    type: 'utility',
    version: '1.0.0',
    isLoaded: () => !!analytics,
    load: (_ctx, instance) => {
      if (settings.enabled === false) return Promise.resolve()
      analytics = instance
      analytics.webPush = api
      analytics.on('identify', identified)
      window.addEventListener('pagehide', pagehide)
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', message)
        // Only inspect an existing subscription; loading never registers or prompts.
        if ('PushManager' in window && 'Notification' in window)
          background(reconcile())
      }
      return Promise.resolve()
    },
    unload: () => {
      pagehide()
      analytics?.off('identify', identified)
      window.removeEventListener('pagehide', pagehide)
      if ('serviceWorker' in navigator)
        navigator.serviceWorker.removeEventListener('message', message)
      if (analytics?.webPush === api) delete analytics.webPush
      return Promise.resolve()
    },
  }
}

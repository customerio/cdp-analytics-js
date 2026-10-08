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
  const workerStorageKey = `cio-webpush:worker:${
    new URL(workerUrl, location.href).pathname
  }`
  let serviceWorker: ServiceWorkerContainer | undefined
  type Device = { endpoint: string; userId: string | null }
  let memory: Device | null = null
  const storageKey = () =>
    `cio-webpush:${new URL(workerUrl, location.href).pathname}`
  const stored = (): Device | null => {
    try {
      const value = localStorage.getItem(storageKey())
      if (!value) return memory
      // Migrate the alpha's endpoint-only records without inventing an owner.
      if (!value.startsWith('{'))
        return (memory = { endpoint: value, userId: null })
      return (memory = JSON.parse(value) as Device)
    } catch {
      return memory
    }
  }
  const save = (device: Device | null): void => {
    memory = device
    try {
      if (device) localStorage.setItem(storageKey(), JSON.stringify(device))
      else localStorage.removeItem(storageKey())
    } catch {
      /* Persistence is optional in private browsing. */
    }
  }
  let mutations: Promise<unknown> = Promise.resolve()
  const mutate = <T>(task: () => Promise<T>): Promise<T> => {
    const result = mutations.then(task)
    mutations = result.catch(() => {})
    return result
  }
  const pending = new Set<(error?: Error) => void>()
  const identified = () => {
    if (analytics.user().id()) {
      pending.forEach((finish) => finish())
      const previous = stored()
      if (previous && previous.userId !== analytics.user().id())
        background(reconcile())
    }
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
    const found = await serviceWorker?.getRegistration(workerUrl)
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
  const device = (token: string, userId?: string) => ({
    ...(userId ? { userId } : {}),
    context: { device: { token, type: 'web' } },
  })
  const deleteDevice = async (previous: Device) => {
    if (previous.userId)
      await analytics.track(
        'Device Deleted',
        {},
        device(previous.endpoint, previous.userId)
      )
  }
  const reset = () => {
    background(
      mutate(async () => {
        const previous = stored()
        if (!previous?.userId) return
        await deleteDevice(previous)
        save({ endpoint: previous.endpoint, userId: null })
      })
    )
  }
  const registerDevice = async (subscription: PushSubscription) => {
    const value = json(subscription)
    await identity()
    return mutate(async () => {
      // Identity may have been reset while this operation was queued.
      const userId = analytics.user().id()
      if (!userId) throw new Error('Web push requires an identified user.')
      const previous = stored()
      if (
        previous &&
        (previous.endpoint !== value.endpoint || previous.userId !== userId)
      ) {
        // A path change may have switched storage keys. Persist the owner at
        // the current path before deletion so a failed request survives reload.
        save(previous)
        await deleteDevice(previous)
        save({ endpoint: previous.endpoint, userId: null })
      }
      await analytics.track(
        'Device Created or Updated',
        {
          webpush_p256dh: value.keys.p256dh,
          webpush_auth: value.keys.auth,
          user_agent: navigator.userAgent,
        },
        device(value.endpoint, userId)
      )
      save({ endpoint: value.endpoint, userId })
      return value
    })
  }
  const reconcile = async (force = false) => {
    const subscription = await live()
    const previous = stored()
    if (
      subscription &&
      (force ||
        previous?.endpoint !== subscription.endpoint ||
        previous?.userId !== analytics.user().id())
    )
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
      const trackUrl =
        settings.trackUrl ??
        (getCDN().includes('cdp-eu.customer.io')
          ? 'https://track-eu.customer.io'
          : 'https://track.customer.io')
      const nextWorkerUrl = opts.serviceWorkerUrl ?? workerUrl
      const url = new URL(nextWorkerUrl, location.href)
      if (url.origin !== location.origin)
        throw new Error('Web push service worker must be same-origin.')
      const existingRegistration =
        await navigator.serviceWorker.getRegistration(url.href)
      const existingWorker =
        existingRegistration?.active ||
        existingRegistration?.waiting ||
        existingRegistration?.installing
      if (
        existingRegistration?.scope === new URL('./', url).href &&
        existingWorker &&
        new URL(existingWorker.scriptURL).pathname !== url.pathname
      )
        throw new Error(
          'Web push would replace an existing service worker. Integrate push handlers into that worker or use a worker in a dedicated scope.'
        )
      url.searchParams.set('track', trackUrl)
      const reg = await navigator.serviceWorker.register(
        url.pathname + url.search
      )
      await activated(reg)
      // Keep the previous lookup if registration or activation fails. Remember
      // its owner before switching keys, including unchanged reloads.
      const carried = stored()
      workerUrl = nextWorkerUrl
      try {
        localStorage.setItem(workerStorageKey, workerUrl)
      } catch {
        /* Persistence is optional in private browsing. */
      }
      // Durably retain the carried owner under the new lookup before awaiting
      // the browser, so a reload and reset can still delete it. Never
      // overwrite a record already present at the destination.
      let destination: string | null = null
      try {
        destination = localStorage.getItem(storageKey())
      } catch {
        /* Persistence is optional in private browsing. */
      }
      if (carried && !destination) save(carried)
      const existing = await reg.pushManager.getSubscription()
      const existingKey = existing?.options?.applicationServerKey
      if (
        existing &&
        (!existingKey ||
          existingKey.byteLength !== key.byteLength ||
          new Uint8Array(existingKey).some((byte, i) => byte !== key[i]))
      ) {
        if (!(await existing.unsubscribe()))
          throw new Error('Browser unsubscribe failed.')
        await mutate(async () => {
          const previous = stored() ?? {
            endpoint: existing.endpoint,
            userId: analytics.user().id() ?? null,
          }
          save(previous)
          await deleteDevice(previous)
          save(null)
        })
      }
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      })
      return registerDevice(subscription)
    },
    unsubscribe: async () => {
      const subscription = await live()
      if (subscription && !(await subscription.unsubscribe()))
        throw new Error('Browser unsubscribe failed.')
      await mutate(async () => {
        const previous = stored()
        const endpoint = previous?.endpoint ?? subscription?.endpoint
        if (!endpoint) return
        const owner = previous?.userId ?? analytics.user().id() ?? null
        // No known owner means no device event was registered to delete.
        const record = { endpoint, userId: owner }
        save(record)
        await deleteDevice(record)
        save(null)
      })
    },
    subscription: async () => {
      try {
        const subscription = await live()
        return subscription ? json(subscription) : null
      } catch {
        return null
      }
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
      try {
        serviceWorker = navigator.serviceWorker
      } catch {
        return Promise.resolve()
      }
      try {
        workerUrl = localStorage.getItem(workerStorageKey) ?? workerUrl
      } catch {
        /* Persistence is optional in private browsing. */
      }
      analytics.webPush = api
      analytics.on('identify', identified)
      analytics.on('reset', reset)
      window.addEventListener('pagehide', pagehide)
      if (serviceWorker) {
        serviceWorker.addEventListener('message', message)
        // Only inspect an existing subscription; loading never registers or prompts.
        if ('PushManager' in window && 'Notification' in window)
          background(reconcile())
      }
      return Promise.resolve()
    },
    unload: () => {
      pagehide()
      analytics?.off('identify', identified)
      analytics?.off('reset', reset)
      window.removeEventListener('pagehide', pagehide)
      serviceWorker?.removeEventListener('message', message)
      if (analytics?.webPush === api) delete analytics.webPush
      return Promise.resolve()
    },
  }
}

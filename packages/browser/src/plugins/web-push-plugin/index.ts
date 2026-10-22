import type { Analytics } from '../../core/analytics'
import type { Plugin } from '../../core/plugin'
import { getCDN } from '../../lib/parse-cdn'
import type { Context } from '../../core/context'
import {
  deviceAccepted,
  deviceDeliveryEvent,
  deviceFinal,
} from '../customerio/device-delivery'
import { deviceAttributes } from './device-attributes'

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

export interface WebPushClickEvent {
  deliveryId: string
  /** Empty string for a notification body click. */
  action: string
  customData?: Record<string, unknown>
}

export interface WebPushReceivedEvent {
  deliveryId: string
  title: string
  customData?: Record<string, unknown>
}

declare global {
  interface WindowEventMap {
    'cio:webpush:click': CustomEvent<WebPushClickEvent>
    'cio:webpush:received': CustomEvent<WebPushReceivedEvent>
  }
}

export interface WebPushAPI {
  /** Returns a function that removes this click listener. */
  onClick(callback: (event: WebPushClickEvent) => void): () => void
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

function hasPushSupport(): boolean {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

function supported(): void {
  if (!hasPushSupport()) {
    throw new Error(
      'Web push requires a supported browser on HTTPS or localhost.'
    )
  }
}

function sameKey(existing: ArrayBuffer, key: Uint8Array): boolean {
  const bytes = new Uint8Array(existing)
  return (
    bytes.byteLength === key.byteLength &&
    bytes.every((byte, i) => byte === key[i])
  )
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
  type Order = { webpush_event_ms: number; webpush_seq: number }
  type Device = {
    endpoint: string
    userId: string | null
    registered?: false
    pendingDelete?: Order & { attempts?: number; nextAttempt?: number }
    pendingCreate?: Order
    attributesFingerprint?: string
  }
  // Keep counters after logout/unsubscribe and across worker path changes.
  const orders = new Map<string, number>()
  const nextOrder = async (endpoint: string): Promise<Order> => {
    const increment = (): Order => {
      const key = `cio-webpush:seq:${endpoint}`
      let seq = orders.get(endpoint) ?? 0
      try {
        const persisted = Number(localStorage.getItem(key))
        if (Number.isSafeInteger(persisted) && persisted > seq) seq = persisted
      } catch {
        /* Persistence is optional in private browsing. */
      }
      seq = Math.max(seq + 1, Date.now())
      orders.set(endpoint, seq)
      try {
        localStorage.setItem(key, String(seq))
      } catch {
        /* Persistence is optional in private browsing. */
      }
      return { webpush_event_ms: Date.now(), webpush_seq: seq }
    }
    // Serialize the read/increment/write across tabs where Web Locks exists.
    // Older/private browsers retain the in-memory/localStorage fallback.
    return navigator.locks
      ? navigator.locks.request(`cio-webpush:${endpoint}`, increment)
      : increment()
  }
  // Without a delivery-owner marker, an identity transition makes an in-flight
  // handoff ambiguous. Fail closed for the rest of this plugin instance.
  let handoffOwner: string | null | undefined
  let identityChanged = false
  let warnedCustomData = false
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
  let selections = 0
  const mutate = <T>(task: () => Promise<T>): Promise<T> => {
    const result = mutations.then(task)
    mutations = result.catch(() => {})
    return result
  }
  const pending = new Set<(error?: Error) => void>()
  const identified = () => {
    if (handoffOwner && handoffOwner !== analytics.user().id())
      identityChanged = true
    if (analytics.user().id()) {
      const waiting = pending.size > 0
      pending.forEach((finish) => finish())
      // Pending subscribe calls already register after identity resolves.
      // Otherwise inspect the browser even without a local registration record.
      if (!waiting) background(reconcile())
    }
  }
  const pagehide = (event?: PageTransitionEvent) => {
    // A bfcache freeze is not the end of this page's lifetime. Retain the live
    // subscription and identity waiters so subscribe still resolves on return.
    if (event?.persisted) return
    pending.forEach((finish) =>
      finish(
        new Error(
          'Web push registration requires analytics.identify(userId) before the page closes.'
        )
      )
    )
  }
  const pageshow = (event: PageTransitionEvent) => {
    if (event.persisted && analytics.user().id()) identified()
  }
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
  const device = (token: string, userId: string, order: Order) => ({
    userId,
    timestamp: new Date(order.webpush_event_ms),
    context: { device: { token, type: 'web', ...order } },
  })
  const deleteHorizon = 7 * 24 * 60 * 60 * 1000
  const maxDeleteAttempts = 20
  let deleteTimer: number | undefined
  let unloaded = false
  const retryDelete = (nextAttempt: number) => {
    window.clearTimeout(deleteTimer)
    if (!unloaded)
      deleteTimer = window.setTimeout(
        () => background(reconcile()),
        Math.max(0, nextAttempt - Date.now())
      )
  }
  // Destination retries reuse the original Context, rather than track()'s
  // initial result. Observe their outcome too, including after a queue reload.
  const delivered = (ctx: Context) => {
    if (ctx.event.event !== 'Device Deleted') return
    const previous = stored()
    const order = previous?.pendingDelete
    const eventDevice = ctx.event.context?.device
    if (
      !previous ||
      !order ||
      previous.userId !== ctx.event.userId ||
      previous.endpoint !== eventDevice?.token ||
      order.webpush_seq !== eventDevice?.webpush_seq ||
      order.webpush_event_ms !== eventDevice?.webpush_event_ms
    )
      return
    const attempts = (order.attempts ?? 0) + 1
    if (
      deviceAccepted(ctx) ||
      deviceFinal(ctx) ||
      attempts >= maxDeleteAttempts ||
      Date.now() - order.webpush_event_ms >= deleteHorizon
    ) {
      window.clearTimeout(deleteTimer)
      save({ endpoint: previous.endpoint, userId: null })
      if (!unloaded) background(reconcile())
    } else {
      const nextAttempt = Math.min(
        Date.now() + Math.min(3600000, 30000 * 2 ** (attempts - 1)),
        order.webpush_event_ms + deleteHorizon
      )
      save({
        ...previous,
        pendingDelete: { ...order, attempts, nextAttempt },
      })
      retryDelete(nextAttempt)
    }
  }
  const deleteDevice = async (previous: Device) => {
    if (previous.userId) {
      // Write before sending. An unacknowledged logout must survive page close,
      // including reloads without an identity or live browser subscription.
      const order =
        previous.pendingDelete ?? (await nextOrder(previous.endpoint))
      if (
        Date.now() - order.webpush_event_ms >= deleteHorizon ||
        (previous.pendingDelete?.attempts ?? 0) >= maxDeleteAttempts
      ) {
        save({ endpoint: previous.endpoint, userId: null })
        return
      }
      const nextAttempt = previous.pendingDelete?.nextAttempt ?? 0
      if (nextAttempt > Date.now()) {
        retryDelete(nextAttempt)
        throw new Error(
          'Web push device deletion is waiting for retry backoff.'
        )
      }
      // Persist a lease before sending so a reload cannot duplicate this attempt.
      save({
        ...previous,
        pendingDelete: {
          ...order,
          nextAttempt: Date.now() + 30000,
        },
      })
      // Also retry when Analytics short-circuits an offline event before it
      // reaches the destination (retryQueue may be disabled).
      retryDelete(Date.now() + 30000)
      const result = await analytics.track(
        'Device Deleted',
        {},
        {
          ...device(previous.endpoint, previous.userId, {
            webpush_seq: order.webpush_seq,
            webpush_event_ms: order.webpush_event_ms,
          }),
          // Journeys deletes by the stored owner's userId alone. Explicit null
          // keeps the current visitor's anonymous ID off the previous owner's
          // event (undefined would be filled during normalization), and a string
          // would also replace Analytics' current anonymous ID.
          anonymousId: null,
        }
      )
      const current = stored()
      if (
        current?.pendingDelete?.webpush_seq === order.webpush_seq &&
        (current.pendingDelete.attempts ?? 0) ===
          (previous.pendingDelete?.attempts ?? 0)
      )
        delivered(result)
      if (!deviceAccepted(result) && !deviceFinal(result))
        throw new Error(
          'Web push device deletion was not accepted; retry cleanup.'
        )
      window.clearTimeout(deleteTimer)
    }
  }
  const reset = () => {
    identityChanged = true
    background(
      mutate(async () => {
        const previous = stored()
        if (!previous?.userId) return
        await deleteDevice(previous)
        save({ endpoint: previous.endpoint, userId: null })
      })
    )
  }
  const attributes = (subscription: PushSubscription) => ({
    ...deviceAttributes(navigator),
    // Only the browser knows which site it subscribed on. Part of the
    // fingerprint, so records registered without it re-register on load.
    origin: location.origin,
    webpush_expiration_time:
      typeof subscription.expirationTime === 'number' &&
      Number.isSafeInteger(subscription.expirationTime) &&
      subscription.expirationTime >= 0
        ? subscription.expirationTime
        : null,
  })
  const registerDevice = async (
    subscription: PushSubscription,
    force = true
  ) => {
    const value = json(subscription)
    const metadata = attributes(subscription)
    await identity()
    return mutate(async () => {
      // Identity may have been reset while this operation was queued.
      const userId = analytics.user().id()
      if (!userId) throw new Error('Web push requires an identified user.')
      const previous = stored()
      // Delivery feedback and identify can reconcile concurrently. Recheck
      // inside the mutation queue so they do not enqueue duplicate Creates.
      if (
        !force &&
        previous?.endpoint === value.endpoint &&
        previous.userId === userId &&
        previous.registered !== false &&
        !previous.pendingDelete &&
        previous.attributesFingerprint === JSON.stringify(metadata)
      )
        return value
      if (
        previous &&
        (previous.pendingDelete ||
          previous.endpoint !== value.endpoint ||
          previous.userId !== userId)
      ) {
        // A path change may have switched storage keys. Persist the owner at
        // the current path before deletion so a failed request survives reload.
        save(previous)
        await deleteDevice(previous)
        save({ endpoint: previous.endpoint, userId: null })
      }
      // Retain the owner for deletion, but never treat a queued/failed attempt
      // as a registration. Reload, identify and pageshow can retry it.
      const current = stored()
      const order =
        current?.endpoint === value.endpoint &&
        current.userId === userId &&
        !current.pendingDelete &&
        current.pendingCreate
          ? current.pendingCreate
          : await nextOrder(value.endpoint)
      save({
        endpoint: value.endpoint,
        userId,
        registered: false,
        pendingCreate: order,
      })
      const result = await analytics.track(
        'Device Created or Updated',
        {
          webpush_p256dh: value.keys.p256dh,
          webpush_auth: value.keys.auth,
          user_agent: navigator.userAgent,
          ...metadata,
        },
        device(value.endpoint, userId, order)
      )
      if (!deviceAccepted(result))
        throw new Error(
          'Web push device registration was not accepted; retry subscribe.'
        )
      if (handoffOwner === undefined) handoffOwner = userId
      save({
        endpoint: value.endpoint,
        userId,
        attributesFingerprint: JSON.stringify(metadata),
      })
      return value
    })
  }
  const reconcile = async (force = false) => {
    if (!hasPushSupport()) return
    const subscription = await live()
    // reset's deletion may still be settling when identify fires. Inspect the
    // record only after earlier mutations have cleared the previous owner.
    await mutations
    if (stored()?.pendingDelete) {
      await mutate(async () => {
        const previous = stored()
        if (!previous?.pendingDelete) return
        await deleteDevice(previous)
        save({ endpoint: previous.endpoint, userId: null })
      })
    }
    const previous = stored()
    if (
      analytics.user().id() &&
      subscription &&
      (force ||
        previous?.endpoint !== subscription.endpoint ||
        previous?.userId !== analytics.user().id() ||
        previous?.registered === false ||
        previous?.attributesFingerprint !==
          JSON.stringify(attributes(subscription)))
    )
      await registerDevice(subscription, force)
  }
  const background = (task: Promise<unknown>) => {
    void task.catch((error: unknown) =>
      console.warn('Customer.io web push:', error)
    )
  }
  const clickListeners = new Set<(event: WebPushClickEvent) => void>()
  const ready = (worker?: ServiceWorker | null) =>
    worker?.postMessage({ type: 'cio-webpush-ready' })
  const controllerchange = () => ready(serviceWorker?.controller)
  const message = (event: MessageEvent) => {
    if (event.data?.type === 'cio-webpush-subscriptionchange')
      background(reconcile(true))
    if (event.data?.type === 'cio-webpush-check-ready')
      ready(event.source as ServiceWorker | null)
    if (typeof event.data?.deliveryId !== 'string') return
    if (
      identityChanged ||
      (handoffOwner && handoffOwner !== analytics.user().id())
    )
      return
    let customData = event.data.customData
    if (
      customData !== undefined &&
      (!customData ||
        typeof customData !== 'object' ||
        Array.isArray(customData) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(customData)))
    ) {
      customData = undefined
      if (!warnedCustomData) {
        warnedCustomData = true
        console.warn('Customer.io web push: ignoring malformed custom data.')
      }
    }
    if (
      event.data.type === 'cio-webpush-click' &&
      typeof event.data.action === 'string'
    ) {
      const detail: WebPushClickEvent = {
        deliveryId: event.data.deliveryId,
        action: event.data.action,
        customData,
      }
      window.dispatchEvent(new CustomEvent('cio:webpush:click', { detail }))
      clickListeners.forEach((callback) => {
        try {
          callback(detail)
        } catch (error) {
          console.warn('Customer.io web push click callback failed:', error)
        }
      })
    }
    if (event.data.type === 'cio-webpush-received') {
      const detail: WebPushReceivedEvent = {
        deliveryId: event.data.deliveryId,
        title: typeof event.data.title === 'string' ? event.data.title : '',
        customData,
      }
      window.dispatchEvent(new CustomEvent('cio:webpush:received', { detail }))
    }
  }
  const api: WebPushAPI = {
    onClick: (callback) => {
      clickListeners.add(callback)
      return () => clickListeners.delete(callback)
    },
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
      // Read the destination before selecting it. The read changes nothing in
      // the browser, so a failed lookup leaves the previous path selected.
      const existing = await reg.pushManager.getSubscription()
      // A browser may not expose an existing subscription's key: unknown, not a mismatch.
      const existingKey = existing?.options?.applicationServerKey ?? null
      // Remember the previous selection and owner, then switch keys without
      // awaiting, including unchanged reloads.
      const previousWorkerUrl = workerUrl
      const sourceKey = storageKey()
      let previousSelection: string | null = null
      try {
        previousSelection = localStorage.getItem(workerStorageKey)
      } catch {
        /* Persistence is optional in private browsing. */
      }
      const carried = stored()
      workerUrl = nextWorkerUrl
      const destinationKey = storageKey()
      // Every subscribe that selects a path advances this, so a stale failure
      // never undoes a later selection at the same or another path.
      const selection = ++selections
      try {
        localStorage.setItem(workerStorageKey, workerUrl)
      } catch {
        /* Persistence is optional in private browsing. */
      }
      // Durably retain the carried owner under the new lookup before awaiting
      // the browser, so a reload after an interrupted switch can still delete
      // it. Never overwrite a record already present at the destination.
      let destination: string | null = null
      try {
        destination = localStorage.getItem(destinationKey)
      } catch {
        /* Persistence is optional in private browsing. */
      }
      const copied = carried && !destination ? JSON.stringify(carried) : null
      if (carried && !destination) save(carried)
      // The browser had no subscription at the new path and created none:
      // restore the previous selection so subscription, unsubscribe, identify
      // and reset still reach the previous path's subscription and owner.
      const rollback = () => {
        if (destinationKey === sourceKey || selection !== selections) return
        try {
          if (copied && localStorage.getItem(destinationKey) === copied)
            localStorage.removeItem(destinationKey)
          if (previousSelection === null)
            localStorage.removeItem(workerStorageKey)
          else localStorage.setItem(workerStorageKey, previousSelection)
        } catch {
          /* Persistence is optional in private browsing. */
        }
        workerUrl = previousWorkerUrl
        // Identity may have changed while the new path was selected.
        if (analytics.user().id()) background(reconcile())
      }
      const rotate = async (current: PushSubscription) => {
        if (!(await current.unsubscribe()))
          throw new Error('Browser unsubscribe failed.')
        await mutate(async () => {
          const previous = stored() ?? {
            endpoint: current.endpoint,
            userId: analytics.user().id() ?? null,
          }
          save(previous)
          await deleteDevice(previous)
          save(null)
        })
      }
      if (existing && existingKey && !sameKey(existingKey, key))
        await rotate(existing)
      const options = { userVisibleOnly: true, applicationServerKey: key }
      let subscription: PushSubscription
      try {
        subscription = await reg.pushManager.subscribe(options)
      } catch (error) {
        if (!existing) rollback()
        // The browser reuses a matching subscription and rejects a different key
        // with InvalidStateError. It uses that error when the worker is gone too,
        // so rotate only while this registration's worker is still active.
        if (
          !existing ||
          existingKey ||
          !(error instanceof DOMException) ||
          error.name !== 'InvalidStateError' ||
          reg.active?.state !== 'activated'
        )
          throw error
        await rotate(existing)
        subscription = await reg.pushManager.subscribe(options)
      }
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
        const record = { ...previous, endpoint, userId: owner }
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
      unloaded = false
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
      handoffOwner = stored()?.userId ?? analytics.user().id() ?? undefined
      if (handoffOwner && handoffOwner !== analytics.user().id())
        identityChanged = true
      analytics.webPush = api
      analytics.on('identify', identified)
      analytics.on('reset', reset)
      analytics.on(deviceDeliveryEvent, delivered)
      window.addEventListener('pagehide', pagehide)
      window.addEventListener('pageshow', pageshow)
      if (serviceWorker) {
        serviceWorker.addEventListener('message', message)
        serviceWorker.addEventListener('controllerchange', controllerchange)
        controllerchange()
        // Only inspect an existing subscription; loading never registers or prompts.
        if (hasPushSupport()) background(reconcile())
      }
      return Promise.resolve()
    },
    unload: () => {
      unloaded = true
      window.clearTimeout(deleteTimer)
      pagehide()
      analytics?.off(deviceDeliveryEvent, delivered)
      analytics?.off('identify', identified)
      analytics?.off('reset', reset)
      window.removeEventListener('pagehide', pagehide)
      window.removeEventListener('pageshow', pageshow)
      serviceWorker?.removeEventListener('message', message)
      serviceWorker?.removeEventListener('controllerchange', controllerchange)
      clickListeners.clear()
      if (analytics?.webPush === api) delete analytics.webPush
      return Promise.resolve()
    },
  }
}

'use strict'
// Customer.io web push service worker. Register this file directly; the web
// push plugin does, adding `?track=` for delivered and opened metrics.
//
// Importing it into your own worker with importScripts is supported only if
// your worker supplies its own lifecycle (skipWaiting, clients.claim) and sets
// `self.cioWebPushLifecycle = false` before the import. An imported copy reads
// `track` from your worker's URL, so it has no track URL, and sends no metrics,
// unless your worker is registered with one.
const trackUrl = new URL(self.location.href).searchParams.get('track')

if (self.cioWebPushLifecycle !== false) {
  self.addEventListener('install', (event) =>
    event.waitUntil(self.skipWaiting())
  )
  self.addEventListener('activate', (event) =>
    event.waitUntil(Promise.all([self.clients.claim(), retryMetrics()]))
  )
}

function owned(deliveryId, deviceId) {
  return (
    typeof deliveryId === 'string' &&
    deliveryId.length > 0 &&
    typeof deviceId === 'string' &&
    deviceId.length > 0
  )
}

// Pending reports and acknowledged receipts share a bounded durable outbox.
// Receipts suppress repeated clicks (including different buttons) for seven days.
// Retries preserve the original timestamp/action. A lost HTTP acknowledgement
// can still replay an accepted request: the server must also be idempotent.
const metricTTL = 7 * 24 * 60 * 60 * 1000
const maxPendingMetrics = 100
const maxMetricRecords = 1000
const metricSyncTag = 'cio-webpush-metrics'
let metricDatabase
let metricTasks = Promise.resolve()

function openMetricDatabase() {
  if (!metricDatabase) {
    metricDatabase = new Promise((resolve, reject) => {
      const request = indexedDB.open('cio-webpush-metrics', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('events', { keyPath: 'key' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }).catch((error) => {
      metricDatabase = undefined
      throw error
    })
  }
  return metricDatabase
}

// Mutations run in one read/write transaction, including the send lease, so
// overlapping worker instances cannot send the same record concurrently.
async function updateMetrics(change) {
  const db = await openMetricDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('events', 'readwrite')
    const store = transaction.objectStore('events')
    const request = store.getAll()
    let result
    request.onsuccess = () => {
      const now = Date.now()
      const records = request.result
        .sort((a, b) => a.created - b.created)
        .filter((record) => {
          if (now - record.created < metricTTL) return true
          store.delete(record.key)
          return false
        })
      result = change(store, records, now)
    }
    transaction.oncomplete = () => resolve(result)
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

async function scheduleMetricSync() {
  try {
    await self.registration.sync?.register(metricSyncTag)
  } catch {
    // Safari and some other browsers lack Background Sync. The next worker
    // startup, push or click will also retry; no timers keep the worker alive.
  }
}

async function flushMetrics() {
  if (!trackUrl) return
  // Each pass visits at most the queue limit; failed records become ineligible
  // until a later wakeup, with exponential backoff capped at one hour.
  for (let i = 0; i < maxPendingMetrics; i++) {
    const record = await updateMetrics((store, records, now) => {
      const due = records.find(
        (entry) => !entry.done && entry.nextAttempt <= now
      )
      if (!due) return
      due.attempts++
      due.nextAttempt =
        now +
        Math.max(30000, Math.min(3600000, 30000 * 2 ** (due.attempts - 1)))
      store.put(due)
      return due
    })
    if (!record) break
    try {
      const response = await fetch(record.url, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify(record.body),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await updateMetrics((store, records) => {
        const current = records.find((entry) => entry.key === record.key)
        if (current) store.put({ ...current, done: true })
      })
    } catch (error) {
      console.warn('Customer.io web push metric failed:', error)
      await scheduleMetricSync()
    }
  }
}

function runMetricTask(task) {
  metricTasks = metricTasks.then(task).catch((error) => {
    // Storage denial must never prevent showing or opening a notification.
    console.warn('Customer.io web push metric storage failed:', error)
  })
  return metricTasks
}

function retryMetrics() {
  return runMetricTask(flushMetrics)
}

async function metric(data, event, action) {
  try {
    const device_id =
      data.device_id ||
      (await self.registration.pushManager.getSubscription())?.endpoint
    if (!trackUrl || !data.delivery_id || !device_id) return
    const body = {
      delivery_id: data.delivery_id,
      device_id,
      event,
      ...(action ? { action } : {}),
      timestamp: Math.floor(Date.now() / 1000),
    }
    const url = trackUrl.replace(/\/$/, '') + '/push/events'
    const key = JSON.stringify([url, data.delivery_id, event, device_id])
    await updateMetrics((store, records, now) => {
      if (records.some((record) => record.key === key)) return
      // Evict oldest pending on overflow; prefer receipts when trimming the
      // total. Storage and deduplication are explicitly bounded, not forever.
      const pending = records.filter((record) => !record.done)
      const victim =
        pending.length >= maxPendingMetrics
          ? pending[0]
          : records.length >= maxMetricRecords
          ? records.find((record) => record.done) || records[0]
          : undefined
      if (victim) store.delete(victim.key)
      store.put({
        key,
        url,
        body,
        created: now,
        attempts: 0,
        nextAttempt: now,
        done: false,
      })
    })
    await scheduleMetricSync()
    await retryMetrics()
  } catch (error) {
    console.warn('Customer.io web push metric storage failed:', error)
  }
}

// Evaluation happens on every worker startup, not only installation. Event
// waitUntil hooks below anchor this work for the lifetime of each wakeup.
const startupMetrics = retryMetrics()
self.addEventListener('sync', (event) => {
  if (event.tag === metricSyncTag) {
    event.waitUntil(
      (async () => {
        await retryMetrics()
        const pending = await updateMetrics((store, records) =>
          records.some((record) => !record.done)
        )
        // Reject while work remains so the browser can schedule another sync,
        // including when this wakeup happened before our backoff elapsed.
        if (pending) throw new Error('Customer.io web push metrics pending')
      })()
    )
  }
})

self.addEventListener('push', (event) => {
  event.waitUntil(Promise.all([startupMetrics, retryMetrics()]))
  event.waitUntil(
    (async () => {
      let payload
      try {
        payload = event.data ? event.data.json() : {}
        if (!payload || typeof payload !== 'object' || Array.isArray(payload))
          throw new Error('Expected a JSON object')
      } catch {
        return
      }
      // The relay adds both markers, including for test sends. A shared worker
      // must leave other providers' payloads for their own handlers.
      if (!owned(payload['CIO-Delivery-ID'], payload['CIO-Delivery-Token']))
        return
      const actions = []
      if (Array.isArray(payload.actions)) {
        for (const entry of payload.actions) {
          // Customer.io trims the same whitespace (trim() leaves U+0085) and
          // counts a label's code points, not UTF-16 units, so an emoji is
          // one of the 32.
          const title =
            typeof entry?.title === 'string'
              ? entry.title.replace(/^[\s\u0085]+|[\s\u0085]+$/g, '')
              : ''
          if (
            !entry ||
            typeof entry.action !== 'string' ||
            !/^[a-z0-9_-]{1,32}$/.test(entry.action) ||
            !title ||
            Array.from(title).length > 32 ||
            actions.some((action) => action.action === entry.action)
          )
            continue
          if (entry.url !== undefined) {
            try {
              if (
                typeof entry.url !== 'string' ||
                new URL(entry.url).protocol !== 'https:'
              )
                continue
            } catch {
              continue
            }
          }
          actions.push({
            action: entry.action,
            title,
            url: entry.url,
          })
          if (actions.length === 2) break
        }
      }
      const data = {
        link: payload.link,
        actions,
        delivery_id: payload['CIO-Delivery-ID'],
        device_id: payload['CIO-Delivery-Token'],
      }
      await self.registration.showNotification(payload.title || 'Customer.io', {
        body: payload.body,
        image: payload.image,
        icon: payload.icon,
        badge: payload.badge,
        actions: actions.map(({ action, title }) => ({ action, title })),
        data,
      })
      await metric(data, 'delivered')
    })()
  )
})

function safeLink(value) {
  if (typeof value !== 'string' || !value.trim()) return
  try {
    // Resolve against the site origin so the worker's path never changes a
    // destination, and open only HTTPS URLs.
    const url = new URL(value, self.location.origin)
    if (url.protocol === 'https:') return url.href
  } catch {
    // A malformed destination is treated like a missing link.
  }
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {}
  // Existing Customer.io notifications already retain these relay markers.
  if (!owned(data.delivery_id, data.device_id)) return
  event.notification.close()
  const action = Array.isArray(data.actions)
    ? data.actions.find((entry) => entry && entry.action === event.action)
    : undefined
  // Start navigation in the click gesture, without waiting for Track or pushManager.
  event.waitUntil(
    Promise.all([
      metric(data, 'opened', event.action),
      self.clients.openWindow(
        safeLink(action?.url) || safeLink(data.link) || '/'
      ),
    ])
  )
})

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      if (!event.newSubscription && event.oldSubscription) {
        await self.registration.pushManager.subscribe(
          event.oldSubscription.options
        )
      }
      const pages = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      for (const page of pages)
        page.postMessage({ type: 'cio-webpush-subscriptionchange' })
      // With no open page, the plugin reconciles the endpoint next time it loads.
    })()
  )
})

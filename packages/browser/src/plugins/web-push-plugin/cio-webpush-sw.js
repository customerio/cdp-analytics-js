'use strict'
// Customer.io web push service worker. Register this file directly; the web
// push plugin does, adding `?track=` for delivered and opened metrics.
//
// This file is self-contained, and it also upgrades itself: at startup it tries
// importScripts on the Customer.io CDN's v1 runtime (this same file, published
// at `/v1/analytics-js/cio-webpush-sw-runtime.v1.js`) and installs that copy
// when it is newer. A blocked, failed, older or incomplete runtime leaves this
// bundled copy in charge, so the worker always installs one handler set.
// `?runtime=<url>` loads the runtime from another URL (such as a first-party
// proxy); `?runtime=off` never loads it.
//
// Importing it into your own worker with importScripts is supported only if
// your worker supplies its own lifecycle (skipWaiting, clients.claim) and sets
// `self.cioWebPushLifecycle = false` before the import. An imported copy reads
// `track` and `runtime` from your worker's URL. Without `track`, no new metrics
// are created; previously queued reports still retry using their original
// tracking URL.
;(function (install) {
  // scripts/build-prep.sh keeps this equal to the package version.
  const version = '0.7.1'

  // A hosted copy is importing this file as its runtime: offer this version to
  // it and install nothing. A breaking change to install's env needs a new
  // runtime file (.v2.js) and api, so that older hosted copies never load it.
  if (self.__cioWebPushImporting) {
    self.__cioWebPushRuntime = { api: 1, version, install }
    return
  }

  const params = new URL(self.location.href).searchParams
  const trackUrl = params.get('track')
  const lifecycle = self.cioWebPushLifecycle !== false
  const env = (addEventListener) => ({ trackUrl, lifecycle, addEventListener })

  function runtimeUrl() {
    const value = params.get('runtime')
    if (value === 'off') return
    try {
      if (value) {
        const url = new URL(value, self.location.href)
        return /^https?:$/.test(url.protocol) ? url.href : undefined
      }
    } catch {
      return
    }
    let eu = false
    try {
      eu = new URL(trackUrl).hostname === 'track-eu.customer.io'
    } catch {
      // Untracked or proxied tracking: use the US CDN.
    }
    return `https://cdp${
      eu ? '-eu' : ''
    }.customer.io/v1/analytics-js/cio-webpush-sw-runtime.v1.js`
  }

  // Strict semver; build metadata is ignored. A prerelease runtime is never
  // installed, and a release outranks a bundled prerelease of the same version.
  function parse(value) {
    const match =
      typeof value === 'string' &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(
        value
      )
    if (!match) return
    const core = match.slice(1, 4).map(Number)
    if (core.every(Number.isSafeInteger))
      return { core, prerelease: Boolean(match[4]) }
  }

  function newer(candidate) {
    const next = parse(candidate)
    const current = parse(version)
    if (!next || !current || next.prerelease) return false
    for (let i = 0; i < 3; i++) {
      if (next.core[i] !== current.core[i])
        return next.core[i] > current.core[i]
    }
    return current.prerelease
  }

  // While the runtime is evaluated and installed, self.addEventListener
  // registers nothing: a runtime may register only through env, so a rejected
  // runtime leaves no listeners behind. This contains a broken runtime, not a
  // hostile one, which could still reach EventTarget.prototype.
  function withoutListeners(run) {
    const own = Object.getOwnPropertyDescriptor(self, 'addEventListener')
    let added = false
    self.addEventListener = () => {
      added = true
    }
    try {
      run()
    } finally {
      if (own) Object.defineProperty(self, 'addEventListener', own)
      else delete self.addEventListener
    }
    if (added) throw new Error('runtime added listeners outside install(env)')
  }

  // Installs a newer runtime. Its listeners are staged and registered only if
  // install returns having registered exactly one complete handler set; other
  // event types are allowed once each. Anything else throws, registering none.
  function installRuntime(runtime) {
    const staged = []
    let open = true
    let result
    withoutListeners(() => {
      result = runtime.install(
        env((type, listener, options) => {
          if (!open)
            throw new Error('register listeners before install returns')
          staged.push([type, listener, options])
        })
      )
    })
    open = false
    const types = staged.map(([type]) => type)
    const expected = [
      'sync',
      'push',
      'message',
      'notificationclick',
      'pushsubscriptionchange',
    ]
    const known = ['install', 'activate', ...expected]
    if (lifecycle) expected.push('install', 'activate')
    if (
      new Set(types).size !== types.length ||
      !known.every(
        (type) => types.includes(type) === expected.includes(type)
      ) ||
      !staged.every(
        ([type, listener]) =>
          typeof type === 'string' && typeof listener === 'function'
      )
    ) {
      // Keep a rejected async install from reporting an unhandled rejection.
      Promise.resolve(result).catch(() => {})
      throw new Error(`incomplete handler set: ${types.join(', ') || 'none'}`)
    }
    for (const [type, listener, options] of staged)
      self.addEventListener(type, listener, options)
    return result
  }

  // importScripts only works synchronously during this first evaluation. An
  // installed worker reuses the copy fetched at install; browsers compare it
  // on update checks and install a new worker version when it changes.
  let runtime
  const url = runtimeUrl()
  if (url) {
    try {
      withoutListeners(() => {
        self.__cioWebPushImporting = true
        delete self.__cioWebPushRuntime
        try {
          self.importScripts(url)
          runtime = self.__cioWebPushRuntime
        } finally {
          delete self.__cioWebPushImporting
          delete self.__cioWebPushRuntime
        }
      })
    } catch {
      // Blocked, offline or broken: the bundled copy below takes over.
      runtime = undefined
    }
  }
  if (runtime) {
    let candidate = 'runtime'
    try {
      candidate = `runtime ${String(runtime.version)}`
      if (
        runtime.api === 1 &&
        typeof runtime.install === 'function' &&
        newer(runtime.version)
      )
        return installRuntime(runtime)
    } catch (error) {
      console.warn(
        `Customer.io web push: ${candidate} failed; using ${version}.`,
        error
      )
    }
  }
  return install(env((type, listener) => self.addEventListener(type, listener)))
})(function install(env) {
  const { trackUrl, addEventListener } = env

  if (env.lifecycle) {
    addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
    addEventListener('activate', (event) =>
      event.waitUntil(self.clients.claim())
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

  async function flushMetrics(scheduleSync = true) {
    const attempted = new Set()
    let failed = false
    // Each pass visits at most the queue limit; failed records become ineligible
    // until a later wakeup, with exponential backoff capped at one hour.
    for (let i = 0; i < maxPendingMetrics; i++) {
      const record = await updateMetrics((store, records, now) => {
        const due = records.find(
          (entry) =>
            !entry.done &&
            !attempted.has(entry.key) &&
            entry.nextAttempt <= now &&
            // Never let a fresh open overtake its delivery's retry/backoff.
            !(
              entry.body.event === 'opened' &&
              records.some(
                (previous) =>
                  !previous.done &&
                  previous.url === entry.url &&
                  previous.body.delivery_id === entry.body.delivery_id &&
                  previous.body.device_id === entry.body.device_id &&
                  previous.body.event === 'delivered'
              )
            )
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
      attempted.add(record.key)
      try {
        const response = await sendMetric(record.url, record.body)
        const terminal =
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        if (!response.ok && !terminal)
          throw new Error(`HTTP ${response.status}`)
        await updateMetrics((store, records) => {
          const current = records.find((entry) => entry.key === record.key)
          if (current) store.put({ ...current, done: true })
        })
      } catch (error) {
        failed = true
        // Back off from completion, not request start: a slow failed request
        // must not already be due when the next queued flush starts.
        await updateMetrics((store, records, now) => {
          const current = records.find((entry) => entry.key === record.key)
          if (current && !current.done && current.attempts === record.attempts)
            store.put({
              ...current,
              nextAttempt:
                now + Math.min(3600000, 30000 * 2 ** (current.attempts - 1)),
            })
        })
        console.warn('Customer.io web push metric failed:', error)
      }
    }
    const pending = await updateMetrics((store, records) =>
      records.some((record) => !record.done)
    )
    if (pending && scheduleSync) await scheduleMetricSync()
    return pending && failed
  }

  function sendMetric(url, body) {
    return fetch(url, {
      method: 'POST',
      // Older browsers still get best-effort reporting without timeout support.
      signal:
        typeof AbortSignal !== 'undefined'
          ? AbortSignal.timeout?.(10000)
          : undefined,
      body: JSON.stringify(body),
    })
  }

  function runMetricTask(task) {
    metricTasks = metricTasks.then(task).catch((error) => {
      // Storage denial must never prevent showing or opening a notification.
      console.warn('Customer.io web push metric storage failed:', error)
    })
    return metricTasks
  }

  function retryMetrics(scheduleSync = true) {
    return runMetricTask(async () => {
      // Avoid creating a database on untracked sites, but drain an existing
      // outbox using each record's original URL after re-registration.
      if (
        trackUrl ||
        !indexedDB.databases ||
        (await indexedDB.databases()).some(
          (database) => database.name === 'cio-webpush-metrics'
        )
      )
        return flushMetrics(scheduleSync)
    })
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
      try {
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
      } catch (error) {
        // Without durable storage retain main's one-shot best-effort reporting.
        console.warn('Customer.io web push metric storage failed:', error)
        await sendMetric(url, body)
        return
      }
      await retryMetrics()
    } catch (error) {
      console.warn('Customer.io web push metric storage failed:', error)
    }
  }

  // Evaluation happens on every worker startup, not only installation. Event
  // waitUntil hooks below anchor this work for the lifetime of each wakeup.
  // Startup may itself be a sync wakeup; do not reset that tag's retry budget.
  // Push/click enqueues schedule sync, and sync rejection requests later retries.
  const startupMetrics = retryMetrics(false)
  addEventListener('sync', (event) => {
    if (event.tag === metricSyncTag) {
      event.waitUntil(
        (async () => {
          // Let rejection ask the browser to retry this sync. Re-registering
          // its tag here resets the browser's retry budget on every failure.
          const failed = await retryMetrics(false)
          // Spend browser retries only when this wakeup actually attempted work.
          // Records merely waiting out backoff can wait for the next push/click.
          if (failed) throw new Error('Customer.io web push metrics pending')
        })()
      )
    }
  })

  addEventListener('push', (event) => {
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
        const options = {}
        try {
          for (const key of ['requireInteraction', 'silent', 'renotify']) {
            if (payload[key] !== undefined) options[key] = Boolean(payload[key])
          }
          for (const key of ['tag', 'lang']) {
            if (payload[key] !== undefined) options[key] = String(payload[key])
          }
          if (['auto', 'ltr', 'rtl'].includes(payload.dir))
            options.dir = payload.dir
          if (payload.timestamp !== undefined) {
            const timestamp = Number(payload.timestamp)
            if (Number.isSafeInteger(timestamp) && timestamp >= 0)
              options.timestamp = timestamp
          }
          if (!options.silent && payload.vibrate !== undefined) {
            const pattern = Array.isArray(payload.vibrate)
              ? payload.vibrate
              : [payload.vibrate]
            options.vibrate = pattern
              .map(Number)
              .filter((value) => Number.isInteger(value) && value >= 0)
              .map((value) => Math.min(value, 4294967295))
          }
          if (!options.tag) delete options.renotify
        } catch (error) {
          // Even malformed JSON objects with shadowed coercion methods must not
          // prevent the base notification from being shown.
          for (const key of Object.keys(options)) delete options[key]
          console.warn(
            'Customer.io web push: ignoring malformed options.',
            error
          )
        }
        const data = {
          ...(payload.custom_data !== undefined
            ? { custom_data: payload.custom_data }
            : {}),
          link: payload.link,
          actions,
          delivery_id: payload['CIO-Delivery-ID'],
          device_id: payload['CIO-Delivery-Token'],
        }
        await self.registration.showNotification(
          payload.title || 'Customer.io',
          {
            ...options,
            body: payload.body,
            image: payload.image,
            icon: payload.icon,
            badge: payload.badge,
            actions: actions.map(({ action, title }) => ({ action, title })),
            data,
          }
        )
        await Promise.all([
          // Chrome checks the OS's displayed-notification list when the push
          // finishes. On macOS it can lag showNotification's resolution and
          // trigger Chrome's generic fallback. Allow native delivery to settle
          // without delaying metrics or the page's received event.
          new Promise((resolve) => setTimeout(resolve, 250)),
          metric(data, 'delivered'),
          appBadge(payload.app_badge),
          received(data, payload.title || 'Customer.io'),
        ])
      })()
    )
  })

  async function appBadge(count) {
    if (!Number.isInteger(count) || count < 0 || count > 99999) return
    try {
      if (count === 0) await self.navigator?.clearAppBadge?.()
      else await self.navigator?.setAppBadge?.(count)
    } catch (error) {
      console.warn('Customer.io web push app badge failed:', error)
    }
  }

  async function received(data, title) {
    try {
      const pages = await self.clients.matchAll({ type: 'window' })
      for (const page of pages)
        page.postMessage({
          type: 'cio-webpush-received',
          deliveryId: data.delivery_id,
          title,
          customData: data.custom_data,
        })
    } catch (error) {
      console.warn('Customer.io web push received handoff failed:', error)
    }
  }

  // A newly opened page may not have loaded the plugin yet. Keep the click alive
  // until its message listener is ready, bounded to avoid retaining a worker for
  // destinations without the plugin. Probe also handles already-open pages.
  const pendingClicks = new Map()
  addEventListener('message', (event) => {
    if (event.data?.type !== 'cio-webpush-ready') return
    const pending = pendingClicks.get(event.source?.id)
    if (!pending) return
    for (const entry of [...pending]) entry.finish(true)
  })

  function clickWhenReady(page, message) {
    return new Promise((resolve) => {
      const pending = pendingClicks.get(page.id) || new Set()
      pendingClicks.set(page.id, pending)
      const entry = {
        finish: (ready) => {
          clearTimeout(timer)
          pending.delete(entry)
          if (!pending.size) pendingClicks.delete(page.id)
          try {
            if (ready) page.postMessage(message)
          } catch (error) {
            console.warn('Customer.io web push click handoff failed:', error)
          }
          resolve()
        },
      }
      const timer = setTimeout(() => entry.finish(false), 10000)
      pending.add(entry)
      try {
        page.postMessage({ type: 'cio-webpush-check-ready' })
      } catch {
        entry.finish(false)
      }
    })
  }

  async function handoff(opened, data, action) {
    try {
      // openWindow returns only an accessible same-origin client. Its URL may
      // already have changed through a redirect or client-side routing.
      const page = await opened
      if (!page) return
      await clickWhenReady(page, {
        type: 'cio-webpush-click',
        deliveryId: data.delivery_id,
        action: action || '',
        customData: data.custom_data,
      })
    } catch (error) {
      console.warn('Customer.io web push click handoff failed:', error)
    }
  }

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

  addEventListener('notificationclick', (event) => {
    const data = event.notification.data || {}
    // Existing Customer.io notifications already retain these relay markers.
    if (!owned(data.delivery_id, data.device_id)) return
    event.notification.close()
    const action = Array.isArray(data.actions)
      ? data.actions.find((entry) => entry && entry.action === event.action)
      : undefined
    // Start navigation in the click gesture, without waiting for Track or pushManager.
    const url = safeLink(action?.url) || safeLink(data.link) || '/'
    const openedMetric = metric(data, 'opened', event.action)
    const opened = self.clients.openWindow(url)
    event.waitUntil(
      Promise.all([
        retryMetrics(),
        openedMetric,
        handoff(opened, data, event.action),
      ])
    )
  })

  addEventListener('pushsubscriptionchange', (event) => {
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
  return startupMetrics
})

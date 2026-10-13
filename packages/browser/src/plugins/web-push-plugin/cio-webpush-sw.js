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

async function metric(data, event, action) {
  try {
    const device_id =
      data.device_id ||
      (await self.registration.pushManager.getSubscription())?.endpoint
    if (!trackUrl || !data.delivery_id || !device_id) return
    await fetch(trackUrl.replace(/\/$/, '') + '/push/events', {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        delivery_id: data.delivery_id,
        device_id,
        event,
        ...(action ? { action } : {}),
        timestamp: Math.floor(Date.now() / 1000),
      }),
    })
  } catch (error) {
    console.warn('Customer.io web push metric failed:', error)
  }
}

self.addEventListener('push', (event) => {
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
      for (const key of [
        'requireInteraction',
        'silent',
        'tag',
        'renotify',
        'vibrate',
        'lang',
        'dir',
        'timestamp',
      ]) {
        if (payload[key] !== undefined) options[key] = payload[key]
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
      await self.registration.showNotification(payload.title || 'Customer.io', {
        ...options,
        body: payload.body,
        image: payload.image,
        icon: payload.icon,
        badge: payload.badge,
        actions: actions.map(({ action, title }) => ({ action, title })),
        data,
      })
      await Promise.all([
        metric(data, 'delivered'),
        appBadge(payload.app_badge),
        received(data),
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

async function received(data) {
  try {
    const pages = await self.clients.matchAll({ type: 'window' })
    for (const page of pages)
      page.postMessage({
        type: 'cio-webpush-received',
        deliveryId: data.delivery_id,
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
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'cio-webpush-ready') return
  const pending = pendingClicks.get(event.source?.id)
  if (!pending) return
  for (const entry of [...pending]) {
    if (event.source.url === entry.url) entry.finish(true)
  }
})

function clickWhenReady(page, message) {
  return new Promise((resolve) => {
    const pending = pendingClicks.get(page.id) || new Set()
    pendingClicks.set(page.id, pending)
    const entry = {
      url: page.url,
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

async function handoff(opened, url, data, action) {
  try {
    const page = await opened
    const pages = await self.clients.matchAll({ type: 'window' })
    const targets = pages.filter((client) => client.url === url)
    if (page?.url === url && !targets.some((client) => client.id === page.id))
      targets.push(page)
    await Promise.all(
      targets.map((client) =>
        clickWhenReady(client, {
          type: 'cio-webpush-click',
          deliveryId: data.delivery_id,
          action: action || '',
          customData: data.custom_data,
        })
      )
    )
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

self.addEventListener('notificationclick', (event) => {
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
      openedMetric,
      handoff(
        opened,
        new URL(url, self.location.origin).href,
        data,
        event.action
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

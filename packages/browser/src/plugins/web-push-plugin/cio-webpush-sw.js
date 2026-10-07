'use strict'
const trackUrl = new URL(self.location.href).searchParams.get('track')

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim())
)

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
        payload = {
          title: 'Notification',
          body: 'You have a new notification.',
        }
      }
      const actions = []
      if (Array.isArray(payload.actions)) {
        for (const entry of payload.actions) {
          if (
            !entry ||
            typeof entry.action !== 'string' ||
            !/^[a-z0-9_-]{1,32}$/.test(entry.action) ||
            typeof entry.title !== 'string' ||
            !entry.title ||
            entry.title.length > 32 ||
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
            title: entry.title,
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

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const action = Array.isArray(data.actions)
    ? data.actions.find((entry) => entry && entry.action === event.action)
    : undefined
  // Start navigation in the click gesture, without waiting for Track or pushManager.
  event.waitUntil(
    Promise.all([
      metric(data, 'opened', event.action),
      self.clients.openWindow(action?.url || data.link || '/'),
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

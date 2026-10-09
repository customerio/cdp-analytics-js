'use strict'
const trackUrl = new URL(self.location.href).searchParams.get('track')

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim())
)

function owned(deliveryId, deviceId) {
  return (
    typeof deliveryId === 'string' &&
    deliveryId.length > 0 &&
    typeof deviceId === 'string' &&
    deviceId.length > 0
  )
}

async function metric(data, event) {
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
      const data = {
        link: payload.link,
        delivery_id: payload['CIO-Delivery-ID'],
        device_id: payload['CIO-Delivery-Token'],
      }
      await self.registration.showNotification(payload.title || 'Customer.io', {
        body: payload.body,
        image: payload.image,
        data,
      })
      await metric(data, 'delivered')
    })()
  )
})

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {}
  // Existing Customer.io notifications already retain these relay markers.
  if (!owned(data.delivery_id, data.device_id)) return
  event.notification.close()
  // Start navigation in the click gesture, without waiting for Track or pushManager.
  event.waitUntil(
    Promise.all([
      metric(data, 'opened'),
      self.clients.openWindow(data.link || '/'),
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

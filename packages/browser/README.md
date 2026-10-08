Customer.io Data Pipelines analytics client for browsers.

## Installation

```
npm install @customerio/cdp-analytics-browser
```

## Usage

```ts
import { AnalyticsBrowser } from '@customerio/cdp-analytics-browser'

const cioanalytics = AnalyticsBrowser.load({ writeKey: '<YOUR_WRITE_KEY>' })

cioanalytics.identify('hello world')

document.body?.addEventListener('click', () => {
  cioanalytics.track('document body clicked!')
})
```

## Web push (internal alpha)

Install this package as above. Enable web push for your Customer.io workspace and
configure its Web Push credential first. Load the plugin explicitly; it is not
loaded by default. Loading does not register a service worker or request permission.
It only checks for an existing subscription to reconcile a changed endpoint.

```ts
import { AnalyticsBrowser, WebPushPlugin } from '@customerio/cdp-analytics-browser'

const [analytics] = await AnalyticsBrowser.load({ writeKey: '<YOUR_WRITE_KEY>' })
await analytics.register(WebPushPlugin({
  vapidPublicKey: '<YOUR_PUBLIC_VAPID_KEY>',
  serviceWorkerUrl: '/cio-webpush-sw.js',
  trackUrl: 'https://track.customer.io',
}))
await analytics.identify('your-user-id')

// Invoke directly from a user gesture, especially on Safari/iOS.
document.querySelector('#subscribe')?.addEventListener('click', () => {
  void analytics.webPush!.subscribe().catch(console.error)
})
```

Alternatively, pass these settings under `integrations['Customer.io Web Push Plugin']`
in the second argument to `AnalyticsBrowser.load`. Set `enabled: false` to disable it.
The host must only enable the alpha for workspaces with the `web-push` flag;
the SDK does not query FlightDeck.

Options:

- `vapidPublicKey`: required public base64url VAPID key (not the private key).
- `serviceWorkerUrl`: defaults to `/cio-webpush-sw.js`; must be same-origin.
- `trackUrl`: defaults to `https://track.customer.io`, or `https://track-eu.customer.io`
  when using the EU CDN. Set it explicitly when proxying the SDK or using the
  standalone plugin with a custom CDN.

Public API on the initialized analytics instance:

```ts
analytics.webPush!.requestPermission() // Promise<NotificationPermission>
analytics.webPush!.subscribe({ vapidPublicKey, serviceWorkerUrl }) // optional overrides
analytics.webPush!.subscription() // Promise<WebPushSubscriptionJSON | null>
analytics.webPush!.unsubscribe() // Promise<void>
```

Identify first. An anonymous subscribe can obtain browser permission and create a
browser subscription, but its device registration promise waits for `identify`;
no anonymous device event is sent. If the page closes (`pagehide`) or the plugin
is unloaded before identification, that promise rejects with an identity error.
Catch the promise, and do not rely on unload-time asynchronous work being displayed.
Device ownership is persisted: reset deletes the previous person's device, and
identifying another person registers it for them. Unsubscribe turns off the browser
subscription even when logged out; deletion uses the stored owner when known.
Per-call worker URLs are persisted so later loads can find the subscription.

Copy `node_modules/@customerio/cdp-analytics-browser/dist/cio-webpush-sw.js` to
`/cio-webpush-sw.js` on your site. Serve it as JavaScript over HTTPS (localhost is
allowed for development), without a redirect. A root worker has root scope. To use
`/notifications/cio-webpush-sw.js`, pass that path as `serviceWorkerUrl`; its default
scope is `/notifications/`. Do not overwrite another application's service worker:
use a dedicated scope or integrate the handlers into your existing worker. The
worker reads the metrics endpoint from its `?track=` query. Rebuild/copy it when
updating the SDK.

Safari supports web push on supported macOS versions; iOS/iPadOS 16.4+ requires an
installed Home Screen web app (with a web app manifest). Request permission from
a user action. Unsupported browsers or denied permission reject `subscribe`.
Changing VAPID keys invalidates existing subscriptions. Calling `subscribe` with
the new key unsubscribes and deletes the old device before registering the new one.

### Notification payload

The worker accepts `title`, `body`, optional `image` (large picture), `icon`,
`badge`, `link` (default click URL), and `actions`:

```json
{
  "title": "Your order is ready",
  "body": "View your order for details.",
  "image": "https://example.com/order.png",
  "icon": "https://example.com/icon.png",
  "badge": "https://example.com/badge.png",
  "link": "https://example.com/orders",
  "actions": [
    {
      "action": "view",
      "title": "View order",
      "url": "https://example.com/orders/123"
    },
    { "action": "later", "title": "Later" }
  ],
  "CIO-Delivery-ID": "<delivery-id>",
  "CIO-Delivery-Token": "<subscription-endpoint>"
}
```

Use HTTPS URLs for icon, badge, and action destinations. Action IDs must be unique
and match `[a-z0-9_-]{1,32}`; titles are trimmed of Unicode whitespace (including
U+0085 and U+FEFF) and must be nonempty and at most
32 Unicode code points (an emoji counts as one), the rule Customer.io applies when
it saves and sends a message.
The worker drops malformed actions and keeps at most two valid entries. The
browser decides how many buttons it shows: Chrome supports two; Firefox may show
none. Image, icon, and badge rendering also depends on the browser and OS.
Unknown payload fields (including `custom_data`) are not notification options.

An action click opens its `url`, falling back to `link` when omitted; a body click
opens `link`. Without a link, navigation falls back to `/`. Delivered/opened
metrics use the delivery ID and subscription endpoint. Action clicks add the
`action` ID to the opened metric. Navigation never waits for the metrics POST;
closing a notification sends no metric.

### DEVIATIONS

The worker has no analytics instance: subscription changes are re-sent only via
an open page or the next load. Reconciliation deletes the stored endpoint before
registering a replacement. Legacy endpoint-only records have no known owner,
so their previous person's device cannot be deleted safely.

### Alpha script demo

With the existing Pipelines analytics snippet already loaded, serve the built
`packages/browser/dist/umd/webPushPlugin.min.js` at the URL below, and copy
`packages/browser/dist/cio-webpush-sw.js` to the site root. Replace the placeholders.
The public write key belongs in the analytics snippet; never include a Track API
key or a private VAPID key. The public snippet uses `cioanalytics`; if you set
`data-global-customerio-analytics-key`, use that name instead.

```html
<button id="subscribe" disabled>Enable notifications</button>
<script src="/dist/umd/webPushPlugin.min.js"></script>
<script>
  const analytics = window.cioanalytics; // match your snippet's global name
  analytics.ready(async function () {
    try {
      await analytics.register(CustomerIOWebPush.WebPushPlugin({
        vapidPublicKey: '<YOUR_PUBLIC_VAPID_KEY>',
        serviceWorkerUrl: '/cio-webpush-sw.js',
        trackUrl: 'https://track.customer.io' // EU: https://track-eu.customer.io
      }));
      await analytics.identify('<YOUR_USER_ID>');
      const button = document.getElementById('subscribe');
      button.disabled = false;
      button.onclick = function () {
        analytics.webPush.subscribe().then(console.log).catch(console.error);
      };
    } catch (error) {
      console.error(error);
    }
  });
</script>
```

`yarn browser+deps build` emits the UMD bundle in `packages/browser/dist/umd/`,
the static worker in `packages/browser/dist/`, and npm JS/types in
`packages/browser/dist/{pkg,cjs,types}/`. The worker ships unbuilt: `yarn browser
test` runs its tests on `src/plugins/web-push-plugin/cio-webpush-sw.js`, so it
needs no build, and the webpack build fails if the `dist/cio-webpush-sw.js` it
writes differs from that source.

## Other Regions

If you're in our [EU data center](https://customer.io/docs/accounts-and-workspaces/data-centers/) you will need to specify an alternate endpoint:

```ts
import { AnalyticsBrowser } from '@customerio/cdp-analytics-browser'

const cioanalytics = AnalyticsBrowser.load({
  cdnURL: 'https://cdp-eu.customer.io',
  writeKey: '<YOUR_WRITE_KEY>'
})

cioanalytics.identify('hello world')
```

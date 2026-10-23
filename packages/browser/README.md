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
import {
  AnalyticsBrowser,
  WebPushPlugin,
} from '@customerio/cdp-analytics-browser'

const [analytics] = await AnalyticsBrowser.load({
  writeKey: '<YOUR_WRITE_KEY>',
})
await analytics.register(
  WebPushPlugin({
    vapidPublicKey: '<YOUR_PUBLIC_VAPID_KEY>',
    serviceWorkerUrl: '/cio-webpush-sw.js',
    trackUrl: 'https://track.customer.io',
  })
)
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
  Register the worker file directly (the plugin does, appending `?track=`). If you
  import it into your own service worker with `importScripts` instead, your worker
  owns its lifecycle: set `self.cioWebPushLifecycle = false` before the import so
  the file skips `skipWaiting()`/`clients.claim()`, and register your worker with
  the same `?track=` query so delivered and opened events still reach Customer.io.
- `trackUrl`: defaults to `https://track.customer.io`, or `https://track-eu.customer.io`
  when using the EU CDN. Set it explicitly when proxying the SDK or using the
  standalone plugin with a custom CDN.
- `runtimeUrl`: where the worker loads its self-updating runtime (see below).
  Defaults to `https://cdp.customer.io/v1/analytics-js/cio-webpush-sw-runtime.v1.js`,
  or `cdp-eu.customer.io` when `trackUrl` is the EU host. Pass an absolute URL or a
  root-relative path (for example `/cio/cio-webpush-sw-runtime.v1.js`) to serve it
  first-party through your proxy, or `false` to keep the worker's bundled copy and
  make no request (registered as `?runtime=off`).

Public API on the initialized analytics instance:

```ts
analytics.webPush!.requestPermission() // Promise<NotificationPermission>
analytics.webPush!.subscribe({ vapidPublicKey, serviceWorkerUrl }) // optional overrides
analytics.webPush!.subscription() // Promise<WebPushSubscriptionJSON | null>
analytics.webPush!.unsubscribe() // Promise<void>
analytics.webPush!.onClick((event) => console.log(event.customData)) // returns a cleanup function
```

Identify first. An anonymous subscribe can obtain browser permission and create a
browser subscription, but its device registration promise waits for `identify`;
no anonymous device event is sent. If the page closes (`pagehide`) or the plugin
is unloaded before identification, that promise rejects with an identity error.
Catch the promise, and do not rely on unload-time asynchronous work being displayed.
Device ownership is persisted per worker path: reset deletes the device of the
person stored for the current path, and identifying another person registers it
for them. Unsubscribe turns off the browser subscription even when logged out;
deletion uses the stored owner when known.
Unacknowledged logout deletes persist with their original event time/order and
retry with backoff (30 seconds to one hour), including after reload. Reloads
within backoff do not enqueue duplicate deletes. Cleanup stops on final HTTP 4xx
(except 408/429), after 20 failed attempts, or after seven days, so it cannot
permanently block registration. A buffered delete's acknowledgement or final
rejection automatically reconciles the current identified user without reload.
Device sequences use `max(previous + 1, Date.now())` (64-bit epoch-ms scale) and
persist across logout. Web Locks serialize sequence allocation across tabs when
available; without locks, allocation remains best effort. After storage loss,
the wall-clock floor assumes the clock has advanced beyond the prior sequence.
Per-call worker URLs are persisted so later loads can find the subscription, as
long as the `serviceWorkerUrl` load option still names the original path. Where
`localStorage` is unavailable (for example, some private browsing modes), owners
and per-call URLs last only for the current page.
To migrate to another worker path, call `analytics.webPush.unsubscribe()` while
still using the old path, then subscribe at the new path. This is the recommended
approach: it removes the old browser subscription and device record; the host
still owns its worker.
Passing a new path directly to `subscribe({ serviceWorkerUrl })` is supported
with limits. If nothing is stored yet for the new path, the old path's stored
owner is retained there before the new subscription is created; a successful
subscribe then deletes that device (when its owner is known) and registers the
new one. If the browser has no subscription at the new path and fails to
create one, the previous path stays selected and its stored owner is unchanged,
so `subscription()`, unsubscribe, identify and reset continue to act on the
previous path. If the failure happens after a new-path subscription was created
or an existing one was rotated, the new path stays selected and reset or a later
subscribe can delete its retained owner. If the new path already has a stored record,
that record wins and the old path's device is neither transferred nor deleted,
so direct migration does not clean up both paths. Subscribe deletes the
destination record's device only when its endpoint or owner differs; an
identical endpoint and owner is sent as an update without a delete. In every
direct case the old browser registration and subscription stay in place.
Changing the `serviceWorkerUrl` load option itself does not read or migrate the
old path's stored record; the plugin uses only what is stored for the new path.
For a new filename in the same scope, the host must also unregister the old
worker after unsubscribing, before subscribing with the new URL. The guard
rejects replacement at that scope even when the old worker previously served
web push; `unsubscribe()` removes the subscription, not the host's worker.

Copy `node_modules/@customerio/cdp-analytics-browser/dist/cio-webpush-sw.js` to
`/cio-webpush-sw.js` on your site. Serve it as JavaScript over HTTPS (localhost is
allowed for development), without a redirect. A root worker has root scope. To use
`/notifications/cio-webpush-sw.js`, pass that path as `serviceWorkerUrl`; its default
scope is `/notifications/`. Do not overwrite another application's service worker:
use a dedicated scope or integrate the handlers into your existing worker and
pass that worker's URL. Subscribe rejects a different worker at the same default
scope before registering or replacing it. The plugin registers its worker as a
classic script, so if your existing worker is a module service worker
(`type: 'module'`), leave it as it is and serve `cio-webpush-sw.js` in a dedicated
scope instead. The ordinary notification permission
request still happens from your user action.

The worker reads the metrics endpoint from its `?track=` query. When integrating
with an existing worker, preserve this query in every host registration call;
registering the bare URL later disables new delivered/opened metrics, but queued
reports retain and retry their original endpoint. Rebuild/copy the push handlers when updating the SDK.

The hosted worker updates itself. It bundles the complete runtime, so it works with
no network request, and at startup it also tries `importScripts` on the Customer.io
CDN's `cio-webpush-sw-runtime.v1.js` (the same file, published by every SDK
release). When that copy is newer than the bundled one it runs instead, so worker
fixes reach your site without re-copying the file. A blocked (for example by an
ad blocker), failed, older, or broken import leaves the bundled copy in charge and
the worker still installs. Browsers check the imported file during their regular
service worker update checks (at least daily) and install the new version when it
changes. Breaking changes ship as a new `.v2.js` file that existing hosted copies
never load. If your site sets a Content Security Policy for the worker, allow
`https://cdp.customer.io` and `https://cdp-eu.customer.io` in its `script-src`, or
serve the runtime first-party with `runtimeUrl`. With `runtimeUrl: false`, update
your hosted copy yourself when you update the SDK.

Delivered/opened reports are saved in an IndexedDB outbox before sending. Offline
requests and retryable HTTP failures retry on worker startup, push, notification
click, and Background Sync (where supported), with 30-second exponential backoff
capped at one hour. HTTP 4xx other than 408/429 are final and suppress replay while
the receipt is retained. Background Sync is registered only while reports remain
pending. Activation, notification display and navigation do not wait for reporting.
An opened report waits for its queued delivered report to finish (including final
rejection); unrelated deliveries can still proceed.
The outbox retains at most 100 pending reports and 1,000 total records for seven
days; overflow evicts the oldest pending report or acknowledged receipt. Repeated
reports for the same delivery, event, and device (regardless of button) are
suppressed while their record is retained. Retries preserve the first timestamp
and action. If storage is unavailable or saving fails, the worker instead makes
one direct best-effort send per event, without durable retries or deduplication.
Older browsers without `AbortSignal.timeout` send without an SDK request timeout.
The worker's implementation is scoped privately for `importScripts` hosts.
Browser termination or a lost HTTP acknowledgement can still replay an accepted
request; end-to-end exactly-once reporting requires server-side idempotency too.

A failed optional Web Push chunk import or plugin construction is warned once
per analytics load and skipped; ordinary analytics continues to initialize.

Safari supports web push on supported macOS versions; iOS/iPadOS 16.4+ requires an
installed Home Screen web app (with a web app manifest). Request permission from
a user action. Unsupported browsers or denied permission reject `subscribe`.
Changing VAPID keys invalidates existing subscriptions. Calling `subscribe` with
the new key unsubscribes and deletes the old device before registering the new one.

### Device attributes

Every `Device Created or Updated` registration (subscribe, updates, and endpoint
reconciliation) sends these device attributes alongside `webpush_p256dh` and
`webpush_auth`:

| Attribute                 | Value                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_agent`              | Original `navigator.userAgent` (unchanged)                                                                                                                           |
| `webpush_expiration_time` | `PushSubscription.expirationTime` as an integer epoch millisecond timestamp; sent as null to clear stale expiry when unknown (common on Chrome, Firefox, and Safari) |
| `browser`                 | `Chrome`, `Edge`, `Firefox`, `Safari`, `Opera`, `Samsung Internet`, or `Other`                                                                                       |
| `browser_version`         | Major version only, as a string (for example, `'154'`); omitted when unknown                                                                                         |
| `os`                      | `macOS`, `Windows`, `iOS`, `iPadOS`, `Android`, `Linux`, `ChromeOS`, or `Other`                                                                                      |
| `origin`                  | The site's `location.origin` (for example, `'https://shop.example.com'`), so each browser records which site it subscribed on                                        |

These finite browser/OS values support segments without parsing UA strings.
The tiny built-in parser prefers `navigator.userAgentData` brands and platform
when available, then falls back to UA tokens. It uses no high-entropy hints or
third-party parser. Chromium is grouped under Chrome; specific Edge, Opera, and
Samsung tokens take precedence over generic Chrome tokens. Desktop-mode iPadOS
is detected using a Macintosh UA plus touch points. iOS Home Screen apps may
omit a browser version: the worker's WebKit engine version is not a Safari major.
Unknown expiry means **unknown**, not an expired subscription. The plugin sends
null to clear a previously stored expiry. A persisted fingerprint of browser,
major version, OS, origin, and expiry triggers re-registration on changes (including
backfilling devices registered by older SDKs on their next page load). Unchanged
attributes do not trigger another registration.

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
Unknown payload fields are not notification options. Optional Advanced options
are passed to `showNotification` only when present:

| Relay payload field  | Value                                                         |
| -------------------- | ------------------------------------------------------------- |
| `requireInteraction` | Boolean; keep on screen until dismissed                       |
| `silent`             | Boolean; suppress sound/vibration                             |
| `tag`                | Replacement tag (1–64 characters: letters, digits, `_ . : -`) |
| `renotify`           | Boolean; requires `tag`                                       |
| `vibrate`            | 1–10 integer durations, each 0–10000 ms                       |
| `lang`               | BCP 47 language tag (up to 35 characters)                     |
| `dir`                | `auto`, `ltr`, or `rtl`                                       |
| `timestamp`          | Event time as epoch milliseconds                              |
| `app_badge`          | Integer 0–99999; 0 clears the app badge                       |
| `custom_data`        | JSON object retained as `notification.data.custom_data`       |

The relay validates these fields (and converts a rendered ISO timestamp to epoch
milliseconds). Composer `require_interaction` becomes relay `requireInteraction`.
The worker does not add defaults when options are absent. It coerces option types,
drops invalid `dir`/timestamps, drops `vibrate` when silent, and drops `renotify`
without a nonempty tag. Malformed coercions fall back to base options.
Browser/OS support varies;
unsupported notification options may be ignored. `app_badge` is distinct from the
notification `badge` image: it calls worker `navigator.setAppBadge(count)` or
`clearAppBadge()` when available. Unsupported or rejected badging does not prevent
notification display or delivery metrics.

An action click opens its `url`, falling back to `link` when omitted; a body click
opens `link`. Click destinations must resolve to HTTPS. Relative links resolve
against the site origin, wherever the worker is installed. An unsafe button URL
falls back to the validated body link. Missing, malformed, or unsafe body links,
including any HTTP link, fall back to `/`. On an HTTP development origin such as
localhost, relative links therefore also open `/`. Delivered/opened
metrics use the delivery ID and subscription endpoint. Action clicks add the
`action` ID to the opened metric. Navigation never waits for the metrics POST;
closing a notification sends no metric.

### Custom data and page events

After starting the opened metric, the worker calls `openWindow` to open the click
destination (the browser may reuse/focus an existing window). It hands the click
only to that returned same-origin client, once, matching readiness by client ID
rather than URL so redirects and router URL changes work. Other matching tabs
receive no click. The plugin dispatches `{ deliveryId, action, customData }` in a
`cio:webpush:click` window `CustomEvent` and invokes click callbacks. `action` is
the button ID, or `''` for a body click; `customData` is `undefined` when absent
or malformed (malformed data is logged once per plugin instance). Worker
postMessage type names are private implementation details:

```ts
const stop = analytics.webPush!.onClick(
  ({ deliveryId, action, customData }) => {
    console.log(deliveryId, action, customData?.orderId)
  }
)
// Alternatively (do not use both unless you want both handlers):
window.addEventListener('cio:webpush:click', (event) => {
  console.log(event.detail.customData)
})
// Remove a callback when its component unmounts:
stop()
```

The published `WebPushClickEvent`, `WebPushReceivedEvent`, and `WebPushAPI` types
include these APIs; window event names are typed through `WindowEventMap`.
Register handlers during page initialization, including on destinations opened
by a click. The worker waits up to 10 seconds for the plugin's readiness handshake
so a newly opened page can install its message listener. No click data is handed
to any tab except the client returned by `openWindow`. If no accessible client exists (for example, a cross-origin
destination), or the plugin does not load in time, navigation and metrics still
work but there is no page callback. The handoff is best-effort, not durable storage.
Unloading the plugin removes its message listeners and click callbacks.

Delivery payloads do not identify the original user. To avoid handing an old
user's in-flight data to a new identity, reset or an identity change since
registration suppresses click and received handoffs for the rest of that plugin
instance, even after re-registration. A fresh instance can resume under its
current registered identity; this guard cannot identify old deliveries after a
reload. Notifications and metrics still work. Do not put secrets in custom data.

On push, the worker also notifies controlled open window clients. The plugin
dispatches `cio:webpush:received` with a cleaned `{ deliveryId, title, customData }`
detail, not the raw worker payload; it does not change page UI:

```ts
window.addEventListener('cio:webpush:received', (event) => {
  console.log(event.detail.deliveryId, event.detail.customData)
})
```

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
  const analytics = window.cioanalytics // match your snippet's global name
  analytics.ready(async function () {
    try {
      await analytics.register(
        CustomerIOWebPush.WebPushPlugin({
          vapidPublicKey: '<YOUR_PUBLIC_VAPID_KEY>',
          serviceWorkerUrl: '/cio-webpush-sw.js',
          trackUrl: 'https://track.customer.io', // EU: https://track-eu.customer.io
        })
      )
      await analytics.identify('<YOUR_USER_ID>')
      const button = document.getElementById('subscribe')
      button.disabled = false
      button.onclick = function () {
        analytics.webPush.subscribe().then(console.log).catch(console.error)
      }
    } catch (error) {
      console.error(error)
    }
  })
</script>
```

`yarn browser+deps build` emits the UMD bundle in `packages/browser/dist/umd/`,
the static worker and its CDN runtime in `packages/browser/dist/`, and npm JS/types in
`packages/browser/dist/{pkg,cjs,types}/`. The worker ships unbuilt: `yarn browser test` runs its tests on `src/plugins/web-push-plugin/cio-webpush-sw.js`, so it
needs no build, and the webpack build fails if the `dist/cio-webpush-sw.js` or
`dist/cio-webpush-sw-runtime.v1.js` it writes differs from that source. Publish the
runtime on the CDN at `/v1/analytics-js/cio-webpush-sw-runtime.v1.js` with every
release; `scripts/build-prep.sh` sets the worker's version, which hosted copies
compare with the CDN's.

## Other Regions

If you're in our [EU data center](https://customer.io/docs/accounts-and-workspaces/data-centers/) you will need to specify an alternate endpoint:

```ts
import { AnalyticsBrowser } from '@customerio/cdp-analytics-browser'

const cioanalytics = AnalyticsBrowser.load({
  cdnURL: 'https://cdp-eu.customer.io',
  writeKey: '<YOUR_WRITE_KEY>',
})

cioanalytics.identify('hello world')
```

---
'@customerio/cdp-analytics-browser': minor
---

Web push: the self-updating worker runtime is now opt-in. By default `subscribe()` registers the worker with `?runtime=off`, so it runs its bundled copy and makes no request to the CDN. Set `runtimeUrl: true` to load the runtime from the Customer.io CDN for your track region, or pass a URL to serve it first-party. A runtime imported into the worker runs on your origin with the worker's full scope, which is why it now needs an explicit choice. Sites that subscribed with an earlier release are re-registered with `?runtime=off` on their next `subscribe()`. Opting in later re-checks the runtime host once per page load and switches back when it answers.

Action: if you want worker fixes to reach your site without re-copying `cio-webpush-sw.js`, set `runtimeUrl: true` (or your first-party URL). Workers you register yourself should add `?runtime=off` unless you opt in.

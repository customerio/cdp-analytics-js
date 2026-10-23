---
'@customerio/cdp-analytics-browser': minor
---

Web push: the hosted service worker now updates itself. `cio-webpush-sw.js` still bundles the complete runtime and works with no network request; at startup it also tries to import `cio-webpush-sw-runtime.v1.js` from the Customer.io CDN (EU when the track host is EU) and uses it when it is newer, so future worker fixes reach sites without re-copying the file. A blocked, failed, older, or broken import falls back to the bundled copy and the worker still installs. The new `runtimeUrl` plugin option serves the runtime first-party (for example through a proxy) or, with `false`, disables the import. The build also emits `dist/cio-webpush-sw-runtime.v1.js` for the CDN.

Action: replace your hosted `cio-webpush-sw.js` with this version once; later releases reach it automatically. If your site's Content Security Policy covers the worker, allow `https://cdp.customer.io` and `https://cdp-eu.customer.io` in `script-src`, or set `runtimeUrl`.

---
'@customerio/cdp-analytics-browser': minor
---

Add the opt-in webPush browser plugin, typed subscription API, standalone UMD bundle, and service worker for notification delivery and open metrics. Register identified users' web devices through the existing Pipelines event path.

Persist device ownership and worker overrides, clean up devices on identity/endpoint changes and VAPID rotation, and allow logged-out browser unsubscribe. Raise the index.js size budget by the measured 115 B gzipped growth (28,608 B on main to 28,723 B with the opt-in import), from 28,672 B to 28,787 B. The corrected build measures 28,715 B using size-limit's webpack and file plugins.

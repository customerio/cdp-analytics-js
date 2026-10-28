---
'@customerio/cdp-analytics-browser': patch
---

Serialise concurrent `webPush.subscribe()` calls so a double click during a VAPID key rotation resolves every call to the same result instead of rejecting with "Browser unsubscribe failed."

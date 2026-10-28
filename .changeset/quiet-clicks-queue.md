---
'@customerio/cdp-analytics-browser': patch
---

Make concurrent `webPush.subscribe()` calls safe during a VAPID key rotation (a double click no longer rejects with "Browser unsubscribe failed."), and order `webPush.unsubscribe()` after any in-flight subscribe's browser work without waiting for an identity.

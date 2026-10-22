---
'@customerio/cdp-analytics-browser': patch
---

Web push: send the subscribing site's origin (`location.origin`) as the device attribute `origin` on subscribe and on the on-load reconcile. A browser registered without it, or under another origin, registers again on its next visit so it picks the attribute up.

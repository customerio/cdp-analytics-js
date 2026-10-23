---
'@customerio/cdp-analytics-browser': patch
---

Allow native notification delivery to settle before completing a web push event. This reduces Chrome's generic "This site has been updated in the background" notice on macOS without delaying delivery metrics or received events.

Action: if you host `cio-webpush-sw.js` yourself, download the new copy.

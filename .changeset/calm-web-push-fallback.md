---
'@customerio/cdp-analytics-browser': patch
---

Fixes web push notifications on Chrome for macOS where Chrome showed its generic "This site has been updated in the background" notice instead of the notification's own banner when the site's tab isn't visible. The service worker now lets macOS finish registering the notification before completing the push event. Delivered metrics and received events aren't delayed.

Action: if you host `cio-webpush-sw.js` yourself, download the new copy.

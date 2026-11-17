---
'@customerio/cdp-analytics-browser': patch
---

Web push worker: report delivered and opened events to the regional `track_url` carried in each push payload, so EU workspaces no longer lose metrics when `?track=` is missing or names the US host. A `?track=` URL on a first-party proxy host still takes precedence, and `?track=` remains the fallback for payloads without `track_url`.

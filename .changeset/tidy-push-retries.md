---
'@customerio/cdp-analytics-browser': patch
---

Keep analytics initialization working when the optional Web Push chunk fails to load or construct. Persist failed delivered/opened reports in a bounded IndexedDB outbox, retry with backoff on worker wakeups, and suppress duplicate reports per delivery, event, and device.

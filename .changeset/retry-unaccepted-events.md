---
'@customerio/cdp-analytics-browser': patch
---

Retry events the Pipelines API did not accept. An event answered with a 5xx, 408 or 429 status is now queued for another attempt with backoff, up to the retry queue's attempt limit, instead of being counted as delivered. This applies to both the standard and `batching` delivery strategies; with `batching`, every event in the failed batch is retried. Other 4xx statuses are not retried. A retried event keeps its original `messageId`, so the API can drop duplicates.

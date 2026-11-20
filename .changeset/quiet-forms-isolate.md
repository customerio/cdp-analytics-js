---
'@customerio/cdp-analytics-browser': patch
---

Keep identity in memory on Customer.io hosted sign-up form pages, so a hosted form no longer reads or writes the `ajs_user_id` and `ajs_anonymous_id` cookies shared across `customer.io`.

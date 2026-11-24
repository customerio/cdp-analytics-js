---
'@customerio/cdp-analytics-browser': minor
---

Add `analytics.setUserJwt(jwt)` for workspaces that require signed in-app tokens. It hands gist-web the JWT the site's backend signed for the signed-in person, and works before the SDK has loaded, so the first in-app request carries it. Snippet pages call `cioanalytics.setUserJwt(jwt)` once their snippet lists the method; an older snippet takes `cioanalytics.push(['setUserJwt', jwt])`. A rejected JWT reaches the in-app plugin's `events` listener as `in-app:user-jwt-rejected` with its `reason`. `analytics.reset()` signs the person out and clears the JWT, while `setUserJwt(null)` withdraws only a JWT the same page handed over.

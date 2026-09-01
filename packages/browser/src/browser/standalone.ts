/* eslint-disable @typescript-eslint/no-floating-promises */
import { getCDN, setGlobalCDNUrl } from '../lib/parse-cdn'
import { setVersionType } from '../plugins/customerio/normalize'
import { isLazyLoadEnabled, getCdnUrlAttribute } from '../lib/lazy-load'

// Capture lazy-load state early, before document.currentScript becomes null
const lazyLoadEnabled = isLazyLoadEnabled()
const cdnUrlOverride = getCdnUrlAttribute()

// The global analytics key must be set first so that subsequent calls to getCdn() fetch the CDN from the correct instance.
const globalAnalyticsKey = (
  document.querySelector(
    'script[data-global-customerio-analytics-key]'
  ) as HTMLScriptElement
)?.dataset.globalCustomerioAnalyticsKey

if (globalAnalyticsKey) {
  setGlobalAnalyticsKey(globalAnalyticsKey)
}

// Apply CDN URL override from data attribute if provided
if (cdnUrlOverride) {
  setGlobalCDNUrl(cdnUrlOverride)
}

if (process.env.ASSET_PATH) {
  if (process.env.ASSET_PATH === '/dist/umd/') {
    // @ts-ignore
    __webpack_public_path__ = '/dist/umd/'
  } else {
    const cdn = getCDN()
    setGlobalCDNUrl(cdn)

    // @ts-ignore
    __webpack_public_path__ = cdn
      ? cdn + '/v1/analytics-js/'
      : 'https://cdp.customer.io/v1/analytics-js/'
  }
}

setVersionType('web')

import { install, setupLazyLoad } from './standalone-analytics'
import '../lib/csp-detection'
import { shouldPolyfill } from '../lib/browser-polyfill'
import { RemoteMetrics } from '../core/stats/remote-metrics'
import { embeddedWriteKey } from '../lib/embedded-write-key'
import { onCSPError } from '../lib/csp-detection'
import { setGlobalAnalyticsKey } from '../lib/global-analytics-helper'

function onError(err?: unknown) {
  console.error('[analytics.js]', 'Failed to load Analytics.js', err)

  new RemoteMetrics().increment('analytics_js.invoke.error', [
    'type:initialization',
    ...(err instanceof Error
      ? [`message:${err?.message}`, `name:${err?.name}`]
      : []),
    `wk:${embeddedWriteKey()}`,
  ])
}

document.addEventListener('securitypolicyviolation', (e) => {
  onCSPError(e).catch(console.error)
})

/**
 * Attempts to run a promise and catch both sync and async errors.
 **/
async function attempt<T>(promise: () => Promise<T>) {
  try {
    const result = await promise()
    return result
  } catch (err) {
    onError(err)
  }
}

/**
 * Initialize analytics based on mode.
 * - Normal mode: auto-install immediately
 * - Lazy-load mode: set up the global analytics object but defer installation
 *   until window.analytics.load() is explicitly called
 */
function initializeAnalytics(): void {
  if (lazyLoadEnabled) {
    // Lazy-load mode: set up buffering but don't fetch settings yet
    setupLazyLoad()
  } else {
    // Normal mode: install immediately
    attempt(install)
  }
}

if (shouldPolyfill()) {
  // load polyfills in order to get AJS to work with old browsers
  const script = document.createElement('script')
  script.setAttribute(
    'src',
    'https://cdnjs.cloudflare.com/ajax/libs/babel-polyfill/7.7.0/polyfill.min.js'
  )

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () =>
      document.body.appendChild(script)
    )
  } else {
    document.body.appendChild(script)
  }

  script.onload = function (): void {
    initializeAnalytics()
  }
} else {
  initializeAnalytics()
}

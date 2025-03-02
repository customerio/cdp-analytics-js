/* eslint-disable @typescript-eslint/no-floating-promises */
import { getCDN, setGlobalCDNUrl } from '../lib/parse-cdn'
import { setVersionType } from '../plugins/customerio/normalize'

// The global analytics key must be set first so that subsequent calls to getCdn() fetch the CDN from the correct instance.
const globalAnalyticsKey = (
  document.querySelector(
    'script[data-global-customerio-analytics-key]'
  ) as HTMLScriptElement
)?.dataset.globalCustomerioAnalyticsKey

if (globalAnalyticsKey) {
  setGlobalAnalyticsKey(globalAnalyticsKey)
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

import { install } from './standalone-analytics'
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
    attempt(install)
  }
} else {
  attempt(install)
}

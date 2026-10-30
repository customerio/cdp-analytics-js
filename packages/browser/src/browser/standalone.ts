/* eslint-disable @typescript-eslint/no-floating-promises */
import { getCDN, setGlobalCDNUrl } from '../lib/parse-cdn'
import { setVersionType } from '../plugins/customerio/normalize'
import {
  chunkIntegrity,
  detectPinnedMode,
  findPinnedScriptSrc,
  pinnedVersionMismatch,
  setPinnedMode,
} from '../lib/pinned'
import { version } from '../generated/version'

// webpack's module require; its loader reads cioIntegrity for chunk loads.
declare const __webpack_require__: {
  cioIntegrity?: (url: string) => string | undefined
}

// The global analytics key must be set first so that subsequent calls to getCdn() fetch the CDN from the correct instance.
const globalAnalyticsKey = (
  document.querySelector(
    'script[data-global-customerio-analytics-key]'
  ) as HTMLScriptElement
)?.dataset.globalCustomerioAnalyticsKey

if (globalAnalyticsKey) {
  setGlobalAnalyticsKey(globalAnalyticsKey)
}

// Pinned mode: this script was loaded from /v1/analytics-js/v/<version>/ and
// that version is this build's. Chunks, plugins and destinations then load
// only from that directory, each checked against a hash compiled into this
// file (see lib/pinned.ts).
const pinnedSrc = findPinnedScriptSrc()
const pinned = detectPinnedMode(pinnedSrc)
const mismatchedVersion = pinnedVersionMismatch(pinnedSrc)
if (mismatchedVersion) {
  console.error(
    '[analytics.js]',
    `Loaded from a pinned path for version ${mismatchedVersion}, but this is version ${version}. Pinned mode is off.`
  )
}

if (pinned) {
  setPinnedMode(pinned)
  // Settings (data, never code) come from the snippet's _cdn if it set one,
  // else from the host the pinned script came from.
  setGlobalCDNUrl(getGlobalAnalytics()?._cdn ?? pinned.cdn)
  // @ts-ignore
  __webpack_public_path__ = pinned.base
  if (typeof __webpack_require__ !== 'undefined') {
    // Read by the chunk loader that webpack.config.js (PinnedBuildPlugin)
    // adds to webpack's script loader.
    __webpack_require__.cioIntegrity = chunkIntegrity
  }
} else if (process.env.ASSET_PATH) {
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
import { createPolyfillScript, shouldPolyfill } from '../lib/browser-polyfill'
import { RemoteMetrics } from '../core/stats/remote-metrics'
import { embeddedWriteKey } from '../lib/embedded-write-key'
import { onCSPError } from '../lib/csp-detection'
import {
  getGlobalAnalytics,
  setGlobalAnalyticsKey,
} from '../lib/global-analytics-helper'

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
  const script = createPolyfillScript()

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

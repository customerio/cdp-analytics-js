import { getGlobalAnalytics } from './global-analytics-helper'
import { embeddedWriteKey } from './embedded-write-key'

const analyticsScriptRegex =
  /(https?:\/\/[\w.\-:]+)\/(?:analytics\.js\/v1|v1\/analytics-js\/snippet)\/[\w\-:]+\/(analytics\.(?:min)\.js)/

const getCDNUrlFromScriptTag = (): string | undefined => {
  let cdn: string | undefined
  const scripts = Array.prototype.slice.call(
    document.querySelectorAll('script')
  )
  for (const s of scripts) {
    const src = s.getAttribute('src') ?? ''
    const result = analyticsScriptRegex.exec(src)

    if (result && result[1]) {
      cdn = result[1]
    }

    // If the script tag has the globalCustomerioAnalyticsKey attribute, then this is a CDP script (not segment).
    if (s.dataset?.globalCustomerioAnalyticsKey != null) {
      break
    }
  }
  return cdn
}

let _globalCDN: string | undefined // set globalCDN as in-memory singleton
const getGlobalCDNUrl = (): string | undefined => {
  const result = _globalCDN ?? getGlobalAnalytics()?._cdn
  return result
}

export const setGlobalCDNUrl = (cdn: string) => {
  const globalAnalytics = getGlobalAnalytics()
  if (globalAnalytics) {
    globalAnalytics._cdn = cdn
  }
  _globalCDN = cdn
}

export const getCDN = (): string => {
  const globalCdnUrl = getGlobalCDNUrl()

  if (globalCdnUrl) return globalCdnUrl

  const cdnFromScriptTag = getCDNUrlFromScriptTag()

  if (cdnFromScriptTag) {
    return cdnFromScriptTag
  } else {
    // it's possible that the CDN is not found in the page because:
    // - the script is loaded through a proxy
    // - the script is removed after execution
    // in this case, we fall back to the default CDN
    return `https://cdp.customer.io`
  }
}

export const getNextIntegrationsURL = () => {
  const cdn = getCDN()
  return `${cdn}/v1/analytics-js/actions`
}

/**
 * Replaces the CDN URL in the script tag with the one from Analytics.js 1.0
 *
 * @returns the path to Analytics JS 1.0
 **/
export function getLegacyAJSPath(): string {
  const writeKey = embeddedWriteKey() ?? getGlobalAnalytics()?._writeKey

  const scripts = Array.prototype.slice.call(
    document.querySelectorAll('script')
  )
  let path: string | undefined = undefined

  for (const s of scripts) {
    const src = s.getAttribute('src') ?? ''
    const result = analyticsScriptRegex.exec(src)

    if (result && result[1]) {
      path = src
      break
    }
  }

  if (path) {
    return path.replace('analytics.min.js', 'analytics.classic.js')
  }

  return `https://cdp.customer.io/analytics.js/v1/${writeKey}/analytics.classic.js`
}

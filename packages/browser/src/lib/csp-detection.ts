import { loadScript } from './load-script'
import { getLegacyAJSPath } from './parse-cdn'
import { getPinnedMode } from './pinned'

let ajsIdentifiedCSP = false

export async function onCSPError(
  e: SecurityPolicyViolationEvent & { disposition?: 'enforce' | 'report' }
): Promise<void> {
  if (e.disposition === 'report') {
    return
  }

  if (!e.blockedURI.includes('cdp.customer.io') || ajsIdentifiedCSP) {
    return
  }

  ajsIdentifiedCSP = true

  console.warn(
    'Your CSP policy is missing permissions required in order to run Analytics.js 2.0'
  )
  // Pinned mode never loads unpinned code, so there is no classic fallback.
  if (getPinnedMode()) return

  console.warn('Reverting to Analytics.js 1.0')

  const classicPath = getLegacyAJSPath()
  await loadScript(classicPath)
}

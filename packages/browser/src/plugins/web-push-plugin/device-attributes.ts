type Browser =
  | 'Chrome'
  | 'Edge'
  | 'Firefox'
  | 'Safari'
  | 'Opera'
  | 'Samsung Internet'
  | 'Other'
type OS =
  | 'macOS'
  | 'Windows'
  | 'iOS'
  | 'iPadOS'
  | 'Android'
  | 'Linux'
  | 'ChromeOS'
  | 'Other'

interface BrowserNavigator {
  userAgent: string
  maxTouchPoints?: number
  userAgentData?: {
    brands?: readonly { brand: string; version: string }[]
    platform?: string
  }
}

// Intentionally small and low-cardinality: no models, full versions, or
// high-entropy client hints. Specific Chromium derivatives precede Chrome.
const browsers: [Browser, RegExp, string][] = [
  ['Samsung Internet', /SamsungBrowser\/(\d+)/, 'Samsung Internet'],
  ['Opera', /(?:OPR|Opera|OPiOS)\/(\d+)/, 'Opera'],
  ['Edge', /(?:Edg|EdgA|EdgiOS|Edge)\/(\d+)/, 'Microsoft Edge'],
  ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
  ['Chrome', /(?:Chrome|Chromium|CriOS)\/(\d+)/, 'Google Chrome'],
  ['Safari', /Version\/(\d+).*Safari\//, 'Safari'],
]

function operatingSystem(nav: BrowserNavigator): OS {
  const ua = nav.userAgent
  // iPadOS can use a desktop Macintosh UA; touch points disambiguate it.
  if (
    /iPad/.test(ua) ||
    (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1)
  )
    return 'iPadOS'
  const platforms: Record<string, OS> = {
    macOS: 'macOS',
    Windows: 'Windows',
    iOS: 'iOS',
    iPadOS: 'iPadOS',
    Android: 'Android',
    Linux: 'Linux',
    'Chrome OS': 'ChromeOS',
    ChromeOS: 'ChromeOS',
  }
  const platform = nav.userAgentData?.platform || ''
  if (Object.prototype.hasOwnProperty.call(platforms, platform))
    return platforms[platform]
  if (/iPhone|iPod/.test(ua)) return 'iOS'
  if (/Android/.test(ua)) return 'Android'
  if (/CrOS/.test(ua)) return 'ChromeOS'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS'
  if (/Linux/.test(ua)) return 'Linux'
  return 'Other'
}

export function deviceAttributes(nav: BrowserNavigator): {
  browser: Browser
  browser_version?: string
  os: OS
} {
  const os = operatingSystem(nav)
  for (const [browser, , brand] of browsers) {
    const hint = nav.userAgentData?.brands?.find(
      (entry) => entry.brand === brand
    )
    const major = hint?.version.match(/^\d+/)?.[0]
    if (major) return { browser, browser_version: major, os }
  }
  const chromium = nav.userAgentData?.brands?.find(
    (entry) => entry.brand === 'Chromium'
  )
  const hintedMajor = chromium?.version.match(/^\d+/)?.[0]
  for (const [browser, pattern] of browsers) {
    const major = nav.userAgent.match(pattern)?.[1]
    if (major)
      return {
        browser,
        browser_version: browser === 'Chrome' ? hintedMajor || major : major,
        os,
      }
  }
  if (hintedMajor)
    return { browser: 'Chrome', browser_version: hintedMajor, os }
  // Home Screen iOS UAs can omit both Safari/ and Version/. There is no
  // honest browser major to report in that case (WebKit/ is not Safari's).
  if (
    (os === 'iOS' || os === 'iPadOS') &&
    /AppleWebKit.*Mobile\//.test(nav.userAgent)
  )
    return { browser: 'Safari', os }
  return { browser: 'Other', os }
}

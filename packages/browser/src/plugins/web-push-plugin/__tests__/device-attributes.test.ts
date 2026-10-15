import { deviceAttributes } from '../device-attributes'

// Browser families from the webpush-polish e2e evidence and Devices audit.
// Chrome 155/macOS and WebKit 26.4 are copied from chrome-probes.log and
// webkit-probes.log. Remaining fixtures cover the reported browser/OS versions
// and real-world derivative/mobile UA formats without any device identifiers.
test.each([
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    'Chrome',
    '155',
    'macOS',
  ],
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0',
    'Firefox',
    '157',
    'macOS',
  ],
  [
    'Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0',
    'Firefox',
    '157',
    'Linux',
  ],
  [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    'Chrome',
    '154',
    'Linux',
  ],
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
    'Safari',
    '27',
    'macOS',
  ],
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15',
    'Safari',
    '26',
    'macOS',
  ],
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    'Safari',
    undefined,
    'iOS',
  ],
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1',
    'Safari',
    '18',
    'iOS',
  ],
  [
    'Mozilla/5.0 (iPad; CPU OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1',
    'Safari',
    '18',
    'iPadOS',
  ],
  [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.71',
    'Edge',
    '141',
    'Windows',
  ],
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0',
    'Opera',
    '124',
    'macOS',
  ],
  [
    'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
    'Samsung Internet',
    '27',
    'Android',
  ],
  [
    'Mozilla/5.0 (X11; CrOS x86_64 15917.71.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Chrome',
    '127',
    'ChromeOS',
  ],
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
    'Chrome',
    '141',
    'iOS',
  ],
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15',
    'Firefox',
    '143',
    'iOS',
  ],
])('parses %s', (userAgent, browser, browser_version, os) => {
  const result = deviceAttributes({ userAgent: userAgent! })
  expect(result).toEqual({
    browser,
    ...(browser_version ? { browser_version } : {}),
    os,
  })
})

test('prefers low-entropy client hints and ignores GREASE brands', () => {
  expect(
    deviceAttributes({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0',
      userAgentData: {
        brands: [
          { brand: 'Not A;Brand', version: '99' },
          { brand: 'Chromium', version: '154' },
          { brand: 'Microsoft Edge', version: '155.1.2' },
        ],
        platform: 'Windows',
      },
    })
  ).toEqual({ browser: 'Edge', browser_version: '155', os: 'Windows' })
})

test.each([
  ['Google Chrome', 'Chrome'],
  ['Opera', 'Opera'],
  ['Samsung Internet', 'Samsung Internet'],
  ['Firefox', 'Firefox'],
  ['Safari', 'Safari'],
  ['Chromium', 'Chrome'],
])('maps client-hint brand %s to a finite browser value', (brand, browser) => {
  expect(
    deviceAttributes({
      userAgent: '',
      userAgentData: {
        brands: [
          { brand: 'Not(A:Brand', version: '99' },
          { brand, version: '154.8.9' },
        ],
        platform: 'Chrome OS',
      },
    })
  ).toEqual({ browser, browser_version: '154', os: 'ChromeOS' })
})

test('prefers Chromium major hints over a reduced Chrome UA', () => {
  expect(
    deviceAttributes({
      userAgent: 'Chrome/140.0.0.0',
      userAgentData: {
        brands: [{ brand: 'Chromium', version: '154' }],
        platform: 'Linux',
      },
    })
  ).toEqual({ browser: 'Chrome', browser_version: '154', os: 'Linux' })
})

test.each([
  'macOS',
  'Windows',
  'iOS',
  'iPadOS',
  'Android',
  'Linux',
  'ChromeOS',
])('maps client-hint platform %s', (platform) => {
  expect(
    deviceAttributes({ userAgent: '', userAgentData: { platform } }).os
  ).toBe(platform)
})

test('does not mistake a desktop-mode iPad for macOS', () => {
  expect(
    deviceAttributes({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
      maxTouchPoints: 5,
    })
  ).toEqual({ browser: 'Safari', browser_version: '18', os: 'iPadOS' })
})

test('generic Chromium hints do not displace an explicit derivative UA', () => {
  expect(
    deviceAttributes({
      userAgent: 'Chrome/140.0.0.0 OPR/124.0.0.0',
      userAgentData: {
        brands: [{ brand: 'Chromium', version: '140' }],
      },
    })
  ).toEqual({ browser: 'Opera', browser_version: '124', os: 'Other' })
})

test.each(['', 'unrecognized', 'Chrome/not-a-version'])(
  'unknown UA is low-cardinality: %s',
  (userAgent) => {
    expect(
      deviceAttributes({
        userAgent,
        userAgentData: {
          brands: [{ brand: 'Invented Browser', version: '999' }],
          platform: 'Invented OS',
        },
      })
    ).toEqual({ browser: 'Other', os: 'Other' })
  }
)

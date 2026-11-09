import {
  chunkIntegrity,
  detectPinnedMode,
  findPinnedScriptSrc,
  firstPartyScriptUrl,
  getPinnedMode,
  integrityTable,
  loadFirstPartyScript,
  parseIntegrityTable,
  PinnedLoadRefused,
  pinnedVersionMismatch,
  setIntegrityTableForTesting,
  setPinnedMode,
  withoutSettingsRuntimeUrl,
} from '../pinned'
import * as loader from '../load-script'
import { version } from '../../generated/version'
import {
  createPolyfillScript,
  POLYFILL_INTEGRITY,
  POLYFILL_URL,
} from '../browser-polyfill'

const hashA = `sha384-${'a'.repeat(64)}`
const hashB = `sha384-${'B'.repeat(63)}/`
const base = `https://cdp.customer.io/v1/analytics-js/v/${version}/`

function scriptsWithSrc(src: string): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll('script')).filter(
    (s) => s.src === src
  )
}

afterEach(() => {
  setPinnedMode(undefined)
  setIntegrityTableForTesting(undefined)
  jest.restoreAllMocks()
  document.head.innerHTML = '<script></script>'
})

beforeEach(() => {
  document.head.innerHTML = '<script></script>'
})

describe('detectPinnedMode', () => {
  it('is on for /v/<build version>/analytics.min.js', () => {
    expect(
      detectPinnedMode(
        `https://cdp.customer.io/v1/analytics-js/v/${version}/analytics.min.js`
      )
    ).toEqual({ version, cdn: 'https://cdp.customer.io', base })
  })

  it('keeps the EU host and a proxy prefix as the base', () => {
    expect(
      detectPinnedMode(
        'https://cdp-eu.customer.io/v1/analytics-js/v/1.2.3/analytics.min.js',
        '1.2.3'
      )
    ).toEqual({
      version: '1.2.3',
      cdn: 'https://cdp-eu.customer.io',
      base: 'https://cdp-eu.customer.io/v1/analytics-js/v/1.2.3/',
    })
    expect(
      detectPinnedMode(
        'https://example.com/cio/v1/analytics-js/v/1.2.3/analytics.min.js?x=1',
        '1.2.3'
      )?.base
    ).toBe('https://example.com/cio/v1/analytics-js/v/1.2.3/')
  })

  it('is off for another version, the unpinned snippet path and other files', () => {
    expect(
      detectPinnedMode(
        'https://cdp.customer.io/v1/analytics-js/v/9.9.9/analytics.min.js',
        '1.2.3'
      )
    ).toBeUndefined()
    expect(
      pinnedVersionMismatch(
        'https://cdp.customer.io/v1/analytics-js/v/9.9.9/analytics.min.js',
        '1.2.3'
      )
    ).toBe('9.9.9')
    for (const src of [
      undefined,
      null,
      '',
      'https://cdp.customer.io/v1/analytics-js/snippet/KEY/analytics.min.js',
      'https://cdp.customer.io/v1/analytics-js/v/1.2.3/ajs-destination.js',
      'https://cdp.customer.io/v1/analytics-js/v/1.2.3/sub/analytics.min.js',
      'javascript:/v1/analytics-js/v/1.2.3/analytics.min.js',
    ]) {
      expect(detectPinnedMode(src, '1.2.3')).toBeUndefined()
    }
    expect(
      pinnedVersionMismatch(
        'https://cdp.customer.io/v1/analytics-js/snippet/KEY/analytics.min.js',
        '1.2.3'
      )
    ).toBeUndefined()
  })

  it("finds the pinned script among the page's scripts", () => {
    document.head.innerHTML = `
      <script src="https://example.com/other.js"></script>
      <script src="${base}analytics.min.js"></script>`
    expect(findPinnedScriptSrc()).toBe(`${base}analytics.min.js`)
    document.head.innerHTML =
      '<script src="https://cdp.customer.io/v1/analytics-js/snippet/KEY/analytics.min.js"></script>'
    expect(findPinnedScriptSrc()).toBeUndefined()
  })
})

describe('integrity table', () => {
  it('is empty while the build token is still in place', () => {
    expect(parseIntegrityTable('__CIO_PINNED_INTEGRITY_TABLE__')).toEqual({})
    // This source file is never post-processed.
    expect(integrityTable()).toEqual({})
  })

  it('parses "<path> <hash>" pairs and drops malformed hashes', () => {
    expect(
      parseIntegrityTable(
        `407.js ${hashA},actions/meta-pixel.js ${hashB},bad.js sha1-xyz,nohash.js`
      )
    ).toEqual({ '407.js': hashA, 'actions/meta-pixel.js': hashB })
  })
})

describe('loadFirstPartyScript (the pinned gate)', () => {
  it('unpinned: loads the unpinned URL exactly as before', async () => {
    const spy = jest
      .spyOn(loader, 'loadScript')
      .mockResolvedValue(document.createElement('script'))
    await loadFirstPartyScript({
      name: 'meta-pixel',
      path: 'actions/meta-pixel.js',
      unpinnedUrl:
        'https://cdp.customer.io/v1/analytics-js/actions/meta-pixel.js',
    })
    expect(spy).toHaveBeenCalledWith(
      'https://cdp.customer.io/v1/analytics-js/actions/meta-pixel.js'
    )
    expect(spy.mock.calls[0]).toHaveLength(1)
  })

  it('pinned, in the table: loads <base>/<path> with integrity and crossorigin', () => {
    setPinnedMode(detectPinnedMode(`${base}analytics.min.js`))
    setIntegrityTableForTesting({ 'actions/meta-pixel.js': hashA })

    void loadFirstPartyScript({
      name: 'meta-pixel',
      path: 'actions/meta-pixel.js',
      unpinnedUrl: 'https://evil.example/meta-pixel.js',
    })

    const [script] = scriptsWithSrc(`${base}actions/meta-pixel.js`)
    expect(script).toBeDefined()
    expect(script.getAttribute('integrity')).toBe(hashA)
    expect(script.getAttribute('crossorigin')).toBe('anonymous')
    expect(scriptsWithSrc('https://evil.example/meta-pixel.js')).toHaveLength(0)
    expect(
      firstPartyScriptUrl({
        path: 'actions/meta-pixel.js',
        unpinnedUrl: 'https://evil.example/meta-pixel.js',
      })
    ).toBe(`${base}actions/meta-pixel.js`)
  })

  it('pinned, not in the table: refuses, logs one error per plugin, requests nothing', async () => {
    setPinnedMode(detectPinnedMode(`${base}analytics.min.js`))
    setIntegrityTableForTesting({ 'actions/meta-pixel.js': hashA })
    const error = jest.spyOn(console, 'error').mockImplementation()
    const before = document.querySelectorAll('script').length

    const load = () =>
      loadFirstPartyScript({
        name: 'evil-plugin',
        path: 'actions/evil-plugin.js',
        unpinnedUrl: 'https://evil.example/evil.js',
      })
    await expect(load()).rejects.toBeInstanceOf(PinnedLoadRefused)
    await expect(load()).rejects.toBeInstanceOf(PinnedLoadRefused)

    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toContain('"evil-plugin"')
    expect(error.mock.calls[0][0]).toContain('actions/evil-plugin.js')
    expect(document.querySelectorAll('script')).toHaveLength(before)
  })

  it('pinned: a path that escapes the directory is just not in the table', async () => {
    setPinnedMode(detectPinnedMode(`${base}analytics.min.js`))
    setIntegrityTableForTesting({ 'actions/meta-pixel.js': hashA })
    jest.spyOn(console, 'error').mockImplementation()
    await expect(
      loadFirstPartyScript({
        name: '../../x',
        path: 'actions/../../x.js',
        unpinnedUrl: 'https://evil.example/x.js',
      })
    ).rejects.toBeInstanceOf(PinnedLoadRefused)
  })
})

describe('chunkIntegrity (webpack chunk loads)', () => {
  it('is undefined when unpinned, so chunks load as before', () => {
    expect(getPinnedMode()).toBeUndefined()
    expect(
      chunkIntegrity('https://cdp.customer.io/v1/analytics-js/407.js')
    ).toBeUndefined()
  })

  it('returns the compiled hash for a chunk under the pinned base', () => {
    setPinnedMode(detectPinnedMode(`${base}analytics.min.js`))
    setIntegrityTableForTesting({ '407.js': hashA })
    expect(chunkIntegrity(`${base}407.js`)).toBe(hashA)
  })

  it('returns a well-formed hash no file has for an unknown chunk, and logs once', () => {
    setPinnedMode(detectPinnedMode(`${base}analytics.min.js`))
    setIntegrityTableForTesting({ '407.js': hashA })
    const error = jest.spyOn(console, 'error').mockImplementation()
    const refused = chunkIntegrity('https://evil.example/407.js')
    expect(refused).toMatch(/^sha384-A{64}$/)
    chunkIntegrity('https://evil.example/407.js')
    expect(error).toHaveBeenCalledTimes(1)
  })
})

describe('withoutSettingsRuntimeUrl (web push)', () => {
  const fromSettings = {
    vapidPublicKey: 'k',
    runtimeUrl: 'https://evil.example/rt.js',
  }

  it('leaves settings alone when unpinned', () => {
    expect(withoutSettingsRuntimeUrl(fromSettings, undefined)).toBe(
      fromSettings
    )
  })

  it('turns the live runtime off when pinned, keeps the customer option', () => {
    setPinnedMode(detectPinnedMode(`${base}analytics.min.js`))
    expect(withoutSettingsRuntimeUrl(fromSettings, undefined)).toEqual({
      vapidPublicKey: 'k',
      runtimeUrl: false,
    })
    const noRuntime: { vapidPublicKey: string; runtimeUrl?: string | false } = {
      vapidPublicKey: 'k',
    }
    expect(withoutSettingsRuntimeUrl(noRuntime, undefined)).toEqual({
      vapidPublicKey: 'k',
      runtimeUrl: false,
    })
    expect(
      withoutSettingsRuntimeUrl(
        { vapidPublicKey: 'k', runtimeUrl: '/rt.js' },
        { runtimeUrl: '/rt.js' }
      )
    ).toEqual({ vapidPublicKey: 'k', runtimeUrl: '/rt.js' })
    const merged = { vapidPublicKey: 'k', runtimeUrl: false as const }
    expect(withoutSettingsRuntimeUrl(merged, { runtimeUrl: false })).toBe(
      merged
    )
  })
})

describe('polyfill', () => {
  it('loads the cdnjs polyfill with integrity and crossorigin', () => {
    const script = createPolyfillScript()
    expect(script.getAttribute('src')).toBe(POLYFILL_URL)
    expect(POLYFILL_URL).toBe(
      'https://cdnjs.cloudflare.com/ajax/libs/babel-polyfill/7.7.0/polyfill.min.js'
    )
    expect(script.getAttribute('integrity')).toBe(POLYFILL_INTEGRITY)
    expect(POLYFILL_INTEGRITY).toBe(
      'sha384-Fbe31ZqFxktD++WKw92rzNU9ROzGC0taO0LK7GrLloHkGRmL60n7Rp4gauiM2cfr'
    )
    expect(script.getAttribute('crossorigin')).toBe('anonymous')
  })
})

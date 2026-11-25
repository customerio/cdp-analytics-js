// Every runtime loader of first-party code goes through the pinned gate.
import * as loader from '../load-script'
import {
  detectPinnedMode,
  setIntegrityTableForTesting,
  setPinnedMode,
} from '../pinned'
import { version } from '../../generated/version'
import { remoteLoader } from '../../plugins/remote-loader'
import { remoteMiddlewares } from '../../plugins/remote-middleware'
import { loadIntegration } from '../../plugins/ajs-destination/loader'
import { onCSPError } from '../csp-detection'
import { Context } from '../../core/context'

const base = `https://cdp.customer.io/v1/analytics-js/v/${version}/`
const hash = `sha384-${'m'.repeat(64)}`
const w = window as any

describe('pinned mode loaders', () => {
  let loadScript: jest.SpyInstance
  let error: jest.SpyInstance
  let warn: jest.SpyInstance

  beforeEach(() => {
    setPinnedMode(detectPinnedMode(`${base}analytics.min.js`))
    setIntegrityTableForTesting({
      'actions/meta-pixel.js': hash,
      'actions/amplitude.js': hash,
    })
    error = jest.spyOn(console, 'error').mockImplementation()
    warn = jest.spyOn(console, 'warn').mockImplementation()
    loadScript = jest
      .spyOn(loader, 'loadScript')
      .mockImplementation(async (src: string) => {
        if (src === `${base}actions/meta-pixel.js`) {
          w['meta-pixelDestination'] = jest.fn(() => ({
            name: 'Meta Pixel',
            version: '1.0.0',
            type: 'destination',
            load: () => Promise.resolve(),
            isLoaded: () => true,
          }))
        }
        if (src === `${base}actions/amplitude.js`) {
          w.amplitudeDeps = []
          w.amplitudeLoader = jest.fn()
          w.amplitudeIntegration = { name: 'amplitude' }
        }
        return document.createElement('script')
      })
  })

  afterEach(() => {
    setPinnedMode(undefined)
    setIntegrityTableForTesting(undefined)
    jest.restoreAllMocks()
  })

  it('remote plugins: ignore the settings URL and libraryName, load the pinned file', async () => {
    w.evilGlobal = jest.fn()
    const plugins = await remoteLoader(
      {
        integrations: {},
        remotePlugins: [
          {
            name: 'meta-pixel',
            creationName: 'meta-pixel',
            url: 'https://evil.example/v1/analytics-js/actions/meta-pixel.js',
            libraryName: 'evilGlobal',
            settings: {},
          },
          {
            name: 'evil-plugin',
            creationName: 'evil-plugin',
            url: 'https://evil.example/evil.js',
            libraryName: 'evilGlobal',
            settings: {},
          },
        ],
      },
      {},
      {},
      true // obfuscate is ignored when pinned
    )

    expect(loadScript).toHaveBeenCalledTimes(1)
    expect(loadScript).toHaveBeenCalledWith(`${base}actions/meta-pixel.js`, {
      integrity: hash,
      crossorigin: 'anonymous',
    })
    expect(w['meta-pixelDestination']).toHaveBeenCalled()
    expect(w.evilGlobal).not.toHaveBeenCalled()
    expect(plugins.map((p) => p.name)).toEqual(['meta-pixel'])
    // One error for the refused plugin, and no "Failed to load" warning.
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toContain('"evil-plugin"')
    expect(warn).not.toHaveBeenCalled()
  })

  it('remote middleware: refused unless pinned', async () => {
    const middleware = await remoteMiddlewares(new Context({ type: 'track' }), {
      integrations: {},
      enabledMiddleware: { '@segment/evil': true },
    })
    expect(middleware).toEqual([])
    expect(loadScript).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('legacy ajs destinations: load actions/<name>.js from the pinned base', async () => {
    const integration = await loadIntegration(
      new Context({ type: 'track' }),
      'Amplitude',
      'latest',
      true
    )
    expect(loadScript).toHaveBeenCalledWith(`${base}actions/amplitude.js`, {
      integrity: hash,
      crossorigin: 'anonymous',
    })
    expect(integration).toEqual({ name: 'amplitude' })
  })

  it('csp detection: no classic fallback', async () => {
    await onCSPError({
      blockedURI: 'https://cdp.customer.io/v1/analytics-js/v/x/407.js',
      disposition: 'enforce',
    } as SecurityPolicyViolationEvent & { disposition: 'enforce' })
    expect(loadScript).not.toHaveBeenCalled()
  })
})

import { AnalyticsBrowser } from '.'
import {
  embeddedWriteKey,
  dataAttributeWriteKey,
} from '../lib/embedded-write-key'
import { AnalyticsSnippet } from './standalone-interface'
import {
  getGlobalAnalytics,
  setGlobalAnalytics,
} from '../lib/global-analytics-helper'

function getWriteKey(): string | undefined {
  // Priority 1: data-write-key attribute on script tag
  const dataAttrKey = dataAttributeWriteKey()
  if (dataAttrKey) {
    return dataAttrKey
  }

  // Priority 2: embedded write key (build-time replacement)
  if (embeddedWriteKey()) {
    return embeddedWriteKey()
  }

  // Priority 3: global analytics object
  const analytics = getGlobalAnalytics()
  if (analytics?._writeKey) {
    return analytics._writeKey
  }

  // Priority 4: parse from script src URL
  const regex = /http.*\/analytics\.js\/v1\/([^/]*)(\/platform)?\/analytics.*/
  const scripts = Array.prototype.slice.call(
    document.querySelectorAll('script')
  )
  let writeKey: string | undefined = undefined

  for (const s of scripts) {
    const src = s.getAttribute('src') ?? ''
    const result = regex.exec(src)

    if (result && result[1]) {
      writeKey = result[1]
      break
    }
  }

  if (!writeKey && document.currentScript) {
    const script = document.currentScript as HTMLScriptElement
    const src = script.src

    const result = regex.exec(src)

    if (result && result[1]) {
      writeKey = result[1]
    }
  }

  return writeKey
}

export async function install(): Promise<void> {
  const writeKey = getWriteKey()
  const options = getGlobalAnalytics()?._loadOptions ?? {}
  if (!writeKey) {
    console.error(
      'Failed to load Write Key. Make sure to use the latest version of the snippet, which can be found in your source settings.'
    )
    return
  }

  setGlobalAnalytics(
    (await AnalyticsBrowser.standalone(writeKey, options)) as AnalyticsSnippet
  )
}

/**
 * Set up lazy-load mode: creates a buffered analytics object that queues
 * all calls until load() is explicitly invoked.
 *
 * Usage:
 * <script src="analytics.min.js" data-write-key="your-key" data-lazy-load="true"></script>
 * <script>
 *   // Queue events before load
 *   analytics.track('event_before_load');
 *
 *   // Later, trigger full initialization
 *   analytics.load();
 * </script>
 */
export function setupLazyLoad(): void {
  const writeKey = getWriteKey()
  if (!writeKey) {
    console.error(
      '[analytics.js] Lazy-load mode requires a write key. ' +
        'Use data-write-key attribute or set window.analytics._writeKey.'
    )
    return
  }

  // Get existing buffer or create new one
  const existingAnalytics = getGlobalAnalytics()
  const buffer: Array<{ method: string; args: unknown[] }> =
    (
      existingAnalytics as unknown as {
        _buffer?: Array<{ method: string; args: unknown[] }>
      }
    )?._buffer ?? []

  // Create a proxy analytics object that buffers calls
  const lazyAnalytics = createLazyAnalyticsProxy(writeKey, buffer)
  setGlobalAnalytics(lazyAnalytics as AnalyticsSnippet)
}

function createLazyAnalyticsProxy(
  writeKey: string,
  buffer: Array<{ method: string; args: unknown[] }>
): Record<string, unknown> {
  const methodsToBuffer = [
    'track',
    'page',
    'identify',
    'group',
    'alias',
    'screen',
    'reset',
    'trackSubmit',
    'trackClick',
    'trackLink',
    'trackForm',
    'pageview',
  ]

  let isLoaded = false
  let loadPromise: Promise<void> | null = null

  const proxy: Record<string, unknown> = {
    _writeKey: writeKey,
    _buffer: buffer,
    _lazyLoaded: true,

    // The load() function triggers actual initialization
    load: (options?: Record<string, unknown>) => {
      if (loadPromise) return loadPromise
      if (isLoaded) return Promise.resolve()

      loadPromise = (async () => {
        const mergedOptions = {
          ...(getGlobalAnalytics()?._loadOptions ?? {}),
          ...options,
        }

        // Store options for install()
        const currentAnalytics = getGlobalAnalytics()
        if (currentAnalytics) {
          currentAnalytics._loadOptions = mergedOptions
        }

        // Run actual installation
        await install()
        isLoaded = true

        // Flush buffered events
        const analytics = getGlobalAnalytics()
        if (analytics && buffer.length > 0) {
          for (const { method, args } of buffer) {
            if (typeof analytics[method] === 'function') {
              ;(analytics[method] as (...a: unknown[]) => void)(...args)
            }
          }
          buffer.length = 0
        }
      })()

      return loadPromise
    },

    // ready() resolves when load() completes
    ready: (callback?: () => void) => {
      if (isLoaded) {
        callback?.()
        return Promise.resolve()
      }
      return proxy.load().then(() => callback?.())
    },
  }

  // Create buffering stubs for all analytics methods
  for (const method of methodsToBuffer) {
    proxy[method] = (...args: unknown[]) => {
      if (isLoaded) {
        const analytics = getGlobalAnalytics()
        if (analytics && typeof analytics[method] === 'function') {
          return (analytics[method] as (...a: unknown[]) => unknown)(...args)
        }
      } else {
        buffer.push({ method, args })
      }
    }
  }

  return proxy
}

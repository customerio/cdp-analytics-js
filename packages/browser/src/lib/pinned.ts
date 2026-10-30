import { version as buildVersion } from '../generated/version'
import { loadScript } from './load-script'

/**
 * Pinned mode (PIN-1029).
 *
 * A customer pins analytics.min.js with Subresource Integrity by loading it
 * from https://cdp.customer.io/v1/analytics-js/v/<version>/analytics.min.js.
 * When the SDK sees that it was loaded from such a path, and the version in
 * the path is its own, every later load of first-party code goes through
 * loadFirstPartyScript() (or, for webpack chunks, chunkIntegrity()): the file
 * comes from the same /v/<version>/ directory and must match a hash in the
 * table below, which the build compiles into analytics.min.js. A file that is
 * not in the table is never requested. URLs from the settings response are
 * never used for code.
 */

// The build (webpack.config.js, PinnedBuildPlugin) replaces this token in
// analytics.min.js with "<path> <sha384-hash>" pairs separated by commas,
// after minification, so the hashes are of the final bytes. Every other build
// (npm modules, the UMD index.js) keeps the token: an empty table.
const PINNED_INTEGRITY_SOURCE = '__CIO_PINNED_INTEGRITY_TABLE__'

export interface PinnedMode {
  /** The SDK version in the script's own path. */
  version: string
  /** Where pinned files live: `<cdn>/v1/analytics-js/v/<version>/`. */
  base: string
  /** Origin (plus any proxy prefix) the script came from, for settings. */
  cdn: string
}

const pinnedScript =
  /^(https?:\/\/[^/?#]+(?:\/[^?#]*?)?)\/v1\/analytics-js\/v\/([^/?#]+)\/analytics\.min\.js(?:[?#].*)?$/

/**
 * Pinned mode for a script URL, or undefined when the URL is not a pinned
 * path for this build's version.
 */
export function detectPinnedMode(
  src: string | null | undefined,
  version: string = buildVersion
): PinnedMode | undefined {
  const match = src ? pinnedScript.exec(src) : null
  if (!match || match[2] !== version) return undefined
  const cdn = match[1]
  return { version, cdn, base: `${cdn}/v1/analytics-js/v/${version}/` }
}

/** The src of the pinned script on the page, if any. */
export function findPinnedScriptSrc(): string | undefined {
  const current = document.currentScript as HTMLScriptElement | null
  if (current?.src && pinnedScript.test(current.src)) return current.src
  // Runs before any polyfill, so ES5 only.
  const scripts = document.querySelectorAll('script')
  for (let i = 0; i < scripts.length; i++) {
    const src = scripts[i].src
    if (src && pinnedScript.test(src)) return src
  }
  return undefined
}

/**
 * A pinned path whose version is not this build's. Pinned mode stays off;
 * this is a misconfigured self-hosted or proxied copy.
 */
export function pinnedVersionMismatch(
  src: string | null | undefined,
  version: string = buildVersion
): string | undefined {
  const match = src ? pinnedScript.exec(src) : null
  return match && match[2] !== version ? match[2] : undefined
}

let active: PinnedMode | undefined

export function setPinnedMode(mode: PinnedMode | undefined): void {
  active = mode
}

export function getPinnedMode(): PinnedMode | undefined {
  return active
}

export function parseIntegrityTable(source: string): Record<string, string> {
  const table: Record<string, string> = {}
  // An unreplaced token starts with "_"; a table starts with a path.
  if (!source || source.charAt(0) === '_') return table
  for (const entry of source.split(',')) {
    const [path, hash] = entry.split(' ')
    if (path && /^sha(256|384|512)-[A-Za-z0-9+/]+=*$/.test(hash ?? '')) {
      table[path] = hash
    }
  }
  return table
}

let table: Record<string, string> | undefined

export function integrityTable(): Record<string, string> {
  return (table ??= parseIntegrityTable(PINNED_INTEGRITY_SOURCE))
}

/** Tests only: use this table instead of the compiled one. */
export function setIntegrityTableForTesting(
  next: Record<string, string> | undefined
): void {
  table = next
  refused.clear()
}

export class PinnedLoadRefused extends Error {
  constructor(public pluginName: string, public path: string) {
    super(
      `Customer.io pinned SDK ${
        active?.version ?? buildVersion
      }: refused to load "${pluginName}": ${path} is not in the integrity table of analytics.min.js.`
    )
    this.name = 'PinnedLoadRefused'
    // The build targets ES5, where subclassing Error loses the prototype.
    Object.setPrototypeOf(this, PinnedLoadRefused.prototype)
  }
}

const refused = new Set<string>()

function refuse(pluginName: string, path: string): PinnedLoadRefused {
  const error = new PinnedLoadRefused(pluginName, path)
  if (!refused.has(pluginName)) {
    refused.add(pluginName)
    console.error(`[analytics.js] ${error.message}`)
  }
  return error
}

/**
 * The single gate for runtime loads of first-party code.
 *
 * Unpinned: loads `unpinnedUrl` exactly as before.
 * Pinned: ignores `unpinnedUrl`, loads `<pinned base>/<path>` with its hash
 * from the compiled table and crossorigin="anonymous", or refuses (one
 * console.error per plugin, a rejected PinnedLoadRefused, nothing requested).
 */
export function loadFirstPartyScript(opts: {
  /** The plugin, for the refusal message. */
  name: string
  /** Path relative to the pinned base, e.g. `actions/meta-pixel.js`. */
  path: string
  /** What the unpinned SDK loads. */
  unpinnedUrl: string
}): Promise<HTMLScriptElement> {
  if (!active) return loadScript(opts.unpinnedUrl)
  const integrity = integrityTable()[opts.path]
  if (!integrity) return Promise.reject(refuse(opts.name, opts.path))
  return loadScript(active.base + opts.path, {
    integrity,
    crossorigin: 'anonymous',
  })
}

/** The URL loadFirstPartyScript() uses for these options. */
export function firstPartyScriptUrl(opts: {
  path: string
  unpinnedUrl: string
}): string {
  return active ? active.base + opts.path : opts.unpinnedUrl
}

// A well-formed hash that no file has: a browser refuses the script. (An
// empty or malformed integrity attribute would let any bytes run.)
const refusedChunkIntegrity =
  'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

/**
 * Integrity for a webpack chunk URL (the build calls this from webpack's
 * script loader). undefined when unpinned: chunks load as before.
 */
export function chunkIntegrity(url: string): string | undefined {
  if (!active) return undefined
  const path =
    url.indexOf(active.base) === 0 ? url.slice(active.base.length) : undefined
  const integrity = path !== undefined ? integrityTable()[path] : undefined
  if (integrity) return integrity
  refuse(`webpack chunk ${path ?? url}`, path ?? url)
  return refusedChunkIntegrity
}

/**
 * Pinned mode honours a web push `runtimeUrl` (code the service worker
 * imports) only from the customer's own load options, never from settings.
 */
export function withoutSettingsRuntimeUrl<T extends { runtimeUrl?: unknown }>(
  merged: T | undefined,
  fromOptions: unknown
): T | undefined {
  if (!active || !merged || merged.runtimeUrl === undefined) return merged
  const optionRuntimeUrl =
    fromOptions && typeof fromOptions === 'object'
      ? (fromOptions as { runtimeUrl?: unknown }).runtimeUrl
      : undefined
  if (optionRuntimeUrl !== undefined) return merged
  const { runtimeUrl: _ignored, ...rest } = merged
  return rest as T
}

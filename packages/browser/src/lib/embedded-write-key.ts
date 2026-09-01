declare global {
  interface Window {
    analyticsWriteKey?: string
  }
}

// This variable is used as an optional fallback for when customers
// host or proxy their own analytics.js.
try {
  window.analyticsWriteKey = '__WRITE_KEY__'
} catch (_) {
  // @ eslint-disable-next-line
}

export function embeddedWriteKey(): string | undefined {
  if (window.analyticsWriteKey === undefined) {
    return undefined
  }

  // this is done so that we don't accidentally override every reference to __write_key__
  return window.analyticsWriteKey !== ['__', 'WRITE', '_', 'KEY', '__'].join('')
    ? window.analyticsWriteKey
    : undefined
}

/**
 * Check for a data-write-key attribute on the current script element.
 * This allows embedding the write key directly in the script tag:
 * <script src="analytics.min.js" data-write-key="your-write-key"></script>
 */
export function dataAttributeWriteKey(): string | undefined {
  const script = document.currentScript as HTMLScriptElement | null
  if (!script) return undefined
  return script.dataset.writeKey || undefined
}

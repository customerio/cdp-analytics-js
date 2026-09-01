/**
 * Lazy-load configuration for the analytics snippet.
 *
 * When a script tag includes data-lazy-load="true", the SDK defers
 * initialization until explicitly triggered via window.analytics.load().
 */

/**
 * Check if lazy-load mode is enabled via data-lazy-load attribute.
 * When enabled, the SDK will not auto-initialize on page load.
 */
export function isLazyLoadEnabled(): boolean {
  const script = document.currentScript as HTMLScriptElement | null
  if (!script) return false
  return script.dataset.lazyLoad === 'true'
}

/**
 * Get the CDN URL override from data-cdn-url attribute.
 * Allows specifying a custom CDN endpoint for settings and bundles.
 */
export function getCdnUrlAttribute(): string | undefined {
  const script = document.currentScript as HTMLScriptElement | null
  if (!script) return undefined
  return script.dataset.cdnUrl || undefined
}

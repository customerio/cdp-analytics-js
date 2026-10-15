export const SECRET_KEY_ERROR =
  'Secret (sk_) keys must not be used in the browser. Use your public key in the browser.'

// Secret sk_ keys (and retired ak_ keys) would be exposed in settings, script
// and metrics URLs.
const SECRET_KEY_PREFIXES = ['sk_', 'ak_']

export function isSecretKey(writeKey: string | undefined): boolean {
  return (
    typeof writeKey === 'string' &&
    SECRET_KEY_PREFIXES.some((prefix) => writeKey.startsWith(prefix))
  )
}

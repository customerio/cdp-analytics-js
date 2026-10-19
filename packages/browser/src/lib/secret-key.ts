export const SECRET_KEY_ERROR =
  'Secret (sk_) keys must not be used in the browser. Use your public key in the browser.'

// Secret sk_ keys would be exposed in settings, script and metrics URLs.
export function isSecretKey(writeKey: string | undefined): boolean {
  return typeof writeKey === 'string' && writeKey.startsWith('sk_')
}

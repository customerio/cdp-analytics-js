import { isSecretKey } from '../secret-key'

describe('isSecretKey', () => {
  test('sk_ keys', () => {
    expect(isSecretKey('sk_us_secret')).toBe(true)
  })

  test('sk_ keys with surrounding whitespace', () => {
    expect(isSecretKey(' sk_us_secret')).toBe(true)
    expect(isSecretKey('\tsk_us_secret \n')).toBe(true)
  })

  test('pk_ keys and missing keys', () => {
    expect(isSecretKey('pk_us_public')).toBe(false)
    expect(isSecretKey(' pk_us_public')).toBe(false)
    expect(isSecretKey(undefined)).toBe(false)
  })
})

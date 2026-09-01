import { embeddedWriteKey, dataAttributeWriteKey } from '../embedded-write-key'

describe('embeddedWriteKey', () => {
  it('it guards against undefined', () => {
    expect(embeddedWriteKey()).toBe(undefined)
  })

  it('it returns undefined when default parameter is set', () => {
    window.analyticsWriteKey = '__WRITE_KEY__'
    expect(embeddedWriteKey()).toBe(undefined)
  })

  it('it returns the write key when the key is set properly', () => {
    window.analyticsWriteKey = 'abc_123_write_key'
    expect(embeddedWriteKey()).toBe('abc_123_write_key')
  })
})

describe('dataAttributeWriteKey', () => {
  let originalCurrentScript: PropertyDescriptor | undefined

  beforeEach(() => {
    originalCurrentScript = Object.getOwnPropertyDescriptor(
      document,
      'currentScript'
    )
  })

  afterEach(() => {
    if (originalCurrentScript) {
      Object.defineProperty(document, 'currentScript', originalCurrentScript)
    }
  })

  it('returns undefined when no currentScript', () => {
    Object.defineProperty(document, 'currentScript', {
      value: null,
      configurable: true,
    })
    expect(dataAttributeWriteKey()).toBeUndefined()
  })

  it('returns undefined when data-write-key is not set', () => {
    const script = document.createElement('script')
    Object.defineProperty(document, 'currentScript', {
      value: script,
      configurable: true,
    })
    expect(dataAttributeWriteKey()).toBeUndefined()
  })

  it('returns the write key from data-write-key attribute', () => {
    const script = document.createElement('script')
    script.dataset.writeKey = 'test-write-key-123'
    Object.defineProperty(document, 'currentScript', {
      value: script,
      configurable: true,
    })
    expect(dataAttributeWriteKey()).toBe('test-write-key-123')
  })
})

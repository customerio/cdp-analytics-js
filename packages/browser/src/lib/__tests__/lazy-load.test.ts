import { isLazyLoadEnabled, getCdnUrlAttribute } from '../lazy-load'

describe('lazy-load', () => {
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

  describe('isLazyLoadEnabled', () => {
    it('returns false when no currentScript', () => {
      Object.defineProperty(document, 'currentScript', {
        value: null,
        configurable: true,
      })
      expect(isLazyLoadEnabled()).toBe(false)
    })

    it('returns false when data-lazy-load is not set', () => {
      const script = document.createElement('script')
      Object.defineProperty(document, 'currentScript', {
        value: script,
        configurable: true,
      })
      expect(isLazyLoadEnabled()).toBe(false)
    })

    it('returns false when data-lazy-load is false', () => {
      const script = document.createElement('script')
      script.dataset.lazyLoad = 'false'
      Object.defineProperty(document, 'currentScript', {
        value: script,
        configurable: true,
      })
      expect(isLazyLoadEnabled()).toBe(false)
    })

    it('returns true when data-lazy-load is true', () => {
      const script = document.createElement('script')
      script.dataset.lazyLoad = 'true'
      Object.defineProperty(document, 'currentScript', {
        value: script,
        configurable: true,
      })
      expect(isLazyLoadEnabled()).toBe(true)
    })
  })

  describe('getCdnUrlAttribute', () => {
    it('returns undefined when no currentScript', () => {
      Object.defineProperty(document, 'currentScript', {
        value: null,
        configurable: true,
      })
      expect(getCdnUrlAttribute()).toBeUndefined()
    })

    it('returns undefined when data-cdn-url is not set', () => {
      const script = document.createElement('script')
      Object.defineProperty(document, 'currentScript', {
        value: script,
        configurable: true,
      })
      expect(getCdnUrlAttribute()).toBeUndefined()
    })

    it('returns the CDN URL when set', () => {
      const script = document.createElement('script')
      script.dataset.cdnUrl = 'https://custom-cdn.example.com'
      Object.defineProperty(document, 'currentScript', {
        value: script,
        configurable: true,
      })
      expect(getCdnUrlAttribute()).toBe('https://custom-cdn.example.com')
    })
  })
})

/** @jest-environment node */
import fs from 'fs'
import path from 'path'
import { createWorker, worker } from './worker-harness'

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(1700000000000))
afterEach(() => jest.restoreAllMocks())

const source = fs.readFileSync(worker, 'utf8')
const bundled = /const version = '([^']*)'/.exec(source)![1]
const usRuntime =
  'https://cdp.customer.io/v1/analytics-js/cio-webpush-sw-runtime.v1.js'
const euRuntime =
  'https://cdp-eu.customer.io/v1/analytics-js/cio-webpush-sw-runtime.v1.js'
const trackUrl = 'https://track.customer.io'
const workerUrl = (params: string) =>
  `https://example.com/cio-webpush-sw.js?${params}`
const tracked = workerUrl(`track=${encodeURIComponent(trackUrl)}`)
const handlers = [
  'install',
  'activate',
  'sync',
  'push',
  'message',
  'notificationclick',
  'pushsubscriptionchange',
]
const push = {
  data: {
    json: () => ({
      'CIO-Delivery-ID': 'delivery',
      'CIO-Delivery-Token': 'endpoint',
      title: 'Hello',
    }),
  },
}

// The CDN runtime is this same file, published at another URL. A marker
// records whether its install ran rather than the bundled copy's. `body`
// replaces the runtime's install, with the original as `install`.
function runtimeWith(version: string, body: string) {
  return (
    source.replace(/const version = '[^']*'/, `const version = '${version}'`) +
    `
;(function () {
  const runtime = self.__cioWebPushRuntime
  const install = runtime.install
  runtime.install = (env) => {
    self.installed = runtime.version
    ${body}
  }
})()`
  )
}

function runtimeAt(version: string, after = '') {
  return runtimeWith(
    version,
    `const result = install(env)
    ${after}
    return result`
  )
}

function nextPatch(version: string) {
  const [major, minor, patch] = version.split(/[.-]/).map(Number)
  return `${major}.${minor}.${patch + 1}`
}

function setup(url: string, scripts: Record<string, string> = {}) {
  return createWorker(worker, url, {}, undefined, {}, scripts)
}

function expectOneHandlerSet(s: ReturnType<typeof setup>) {
  expect(s.registrations.map(([type]) => type).sort()).toEqual(
    [...handlers].sort()
  )
}

async function expectWorking(s: ReturnType<typeof setup>) {
  await s.startup
  await s.invoke('push', push)
  expect(s.showNotification).toHaveBeenCalledWith(
    'Hello',
    expect.objectContaining({
      data: expect.objectContaining({ delivery_id: 'delivery' }),
    })
  )
  expect(s.fetch).toHaveBeenCalledWith(
    `${trackUrl}/push/events`,
    expect.objectContaining({
      body: expect.stringContaining('"event":"delivered"'),
    })
  )
}

describe('cio-webpush-sw.js runtime upgrade', () => {
  test('installs the bundled copy when the runtime cannot be imported', async () => {
    const s = setup(tracked)
    expect(s.importScripts).toHaveBeenCalledTimes(1)
    expect(s.importScripts).toHaveBeenCalledWith(usRuntime)
    expect(s.self).not.toHaveProperty('installed')
    expect(s.warn).not.toHaveBeenCalled()
    expectOneHandlerSet(s)
    await expectWorking(s)
  })

  test('installs a newer runtime instead of the bundled copy', async () => {
    const newer = nextPatch(bundled)
    const s = setup(tracked, { [usRuntime]: runtimeAt(newer) })
    expect(s.self).toHaveProperty('installed', newer)
    expectOneHandlerSet(s)
    await expectWorking(s)
    // The handshake leaves no globals behind.
    expect(s.self).not.toHaveProperty('__cioWebPushRuntime')
    expect(s.self).not.toHaveProperty('__cioWebPushImporting')
  })

  test.each([
    ['the same', () => bundled],
    ['an older', () => '0.0.1'],
    ['a malformed', () => 'next'],
    ['a numeric-prefixed', () => `${nextPatch(bundled)}garbage`],
    ['a four-part', () => `${nextPatch(bundled)}.1`],
    ['a zero-padded', () => `0${nextPatch(bundled)}`],
    ['a space-padded', () => ` ${nextPatch(bundled)}`],
    ['a prerelease', () => `${nextPatch(bundled)}-beta.1`],
    ['an empty prerelease', () => `${nextPatch(bundled)}-`],
    ['an empty prerelease identifier', () => `${nextPatch(bundled)}-beta..1`],
    ['an empty build', () => `${nextPatch(bundled)}+`],
    ['an all-dots build', () => `${nextPatch(bundled)}+..`],
    ['a leading-dot build', () => `${nextPatch(bundled)}+.build`],
    ['a trailing-dot build', () => `${nextPatch(bundled)}+build.`],
    ['an empty build identifier', () => `${nextPatch(bundled)}+build..7`],
    ['a newline-terminated', () => `${nextPatch(bundled)}\n`],
  ])('keeps the bundled copy for %s runtime version', async (_, version) => {
    const s = setup(tracked, { [usRuntime]: runtimeAt(version()) })
    expect(s.importScripts).toHaveBeenCalledWith(usRuntime)
    expect(s.self).not.toHaveProperty('installed')
    expectOneHandlerSet(s)
    await expectWorking(s)
  })

  test.each(['+build.7', '+001.sha-5114f85'])(
    'installs a newer runtime with build metadata %s',
    async (build) => {
      const newer = `${nextPatch(bundled)}${build}`
      const s = setup(tracked, { [usRuntime]: runtimeAt(newer) })
      expect(s.self).toHaveProperty('installed', newer)
      expectOneHandlerSet(s)
      await expectWorking(s)
    }
  )

  // Committing the staged set must never leave a partial set behind.
  test('ignores listener options from a newer runtime', async () => {
    const s = setup(tracked, {
      [usRuntime]: runtimeWith(
        nextPatch(bundled),
        `return install({ ...env, addEventListener: (type, listener) =>
          env.addEventListener(type, listener, type === 'notificationclick'
            ? { get capture() { throw new Error('broken listener options') } }
            : undefined) })`
      ),
    })
    expect(s.self).toHaveProperty('installed', nextPatch(bundled))
    expect(s.warn).not.toHaveBeenCalled()
    expectOneHandlerSet(s)
    await expectWorking(s)
    expect(s.showNotification).toHaveBeenCalledTimes(1)
  })

  test('removes committed listeners when registering the runtime fails', async () => {
    const s = createWorker(
      worker,
      tracked,
      {},
      undefined,
      {},
      { [usRuntime]: runtimeAt(nextPatch(bundled)) },
      'notificationclick'
    )
    expect(s.self).toHaveProperty('installed', nextPatch(bundled))
    expect(s.warn).toHaveBeenCalledWith(
      expect.stringContaining(`failed; using ${bundled}`),
      expect.objectContaining({
        message: expect.stringContaining('NotSupportedError'),
      })
    )
    expectOneHandlerSet(s)
    await expectWorking(s)
    expect(s.showNotification).toHaveBeenCalledTimes(1)
  })

  test.each([2, '1'])(
    'keeps the bundled copy for a runtime with api %p',
    async (api) => {
      const s = setup(tracked, {
        [usRuntime]: runtimeAt(nextPatch(bundled)).replace(
          '{ api: 1, version, install }',
          `{ api: ${JSON.stringify(api)}, version, install }`
        ),
      })
      expect(s.self).not.toHaveProperty('installed')
      expectOneHandlerSet(s)
      await expectWorking(s)
    }
  )

  test('falls back to the bundled copy when the runtime throws during install', async () => {
    const s = setup(tracked, {
      [usRuntime]: runtimeAt(
        nextPatch(bundled),
        "throw new Error('broken runtime')"
      ),
    })
    // The failed runtime's staged listeners were never registered.
    expect(s.self).toHaveProperty('installed', nextPatch(bundled))
    expect(s.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed; using'),
      expect.objectContaining({ message: 'broken runtime' })
    )
    expectOneHandlerSet(s)
    await expectWorking(s)
    expect(s.showNotification).toHaveBeenCalledTimes(1)
  })

  // A broken runtime must never leave zero, partial or duplicate handlers:
  // its listeners count only if install returns with one complete set.
  test.each([
    ['registers nothing', 'return Promise.resolve()', {}],
    [
      'registers only push',
      `return install({ ...env, addEventListener: (type, listener) => {
        if (type === 'push') env.addEventListener(type, listener)
      } })`,
      {},
    ],
    [
      'registers push twice',
      `const result = install(env)
      env.addEventListener('push', () => {})
      return result`,
      {},
    ],
    [
      'rejects before registering',
      `return Promise.reject(new Error('async broken runtime'))`,
      {},
    ],
    [
      'registers after returning',
      `return Promise.resolve().then(() => install(env))`,
      {},
    ],
    [
      'registers install and activate despite the opt-out',
      'return install({ ...env, lifecycle: true })',
      { cioWebPushLifecycle: false },
    ],
    [
      'registers directly on self',
      `return install({ ...env, addEventListener: (type, listener) =>
        self.addEventListener(type, listener) })`,
      {},
    ],
    [
      'registers directly on self, then throws',
      `install({ ...env, addEventListener: (type, listener) =>
        self.addEventListener(type, listener) })
      throw new Error('broken runtime')`,
      {},
    ],
  ])(
    'falls back to the bundled copy when the runtime %s',
    async (_, body, globals: Record<string, unknown>) => {
      const lifecycle = !('cioWebPushLifecycle' in globals)
      const s = createWorker(
        worker,
        tracked,
        globals,
        undefined,
        {},
        {
          [usRuntime]: runtimeWith(nextPatch(bundled), body),
        }
      )
      expect(s.self).toHaveProperty('installed', nextPatch(bundled))
      expect(s.warn).toHaveBeenCalledWith(
        expect.stringContaining(`failed; using ${bundled}`),
        expect.anything()
      )
      expect(s.registrations.map(([type]) => type).sort()).toEqual(
        handlers
          .filter(
            (type) => lifecycle || !['install', 'activate'].includes(type)
          )
          .sort()
      )
      await expectWorking(s)
      expect(s.showNotification).toHaveBeenCalledTimes(1)
      // After those awaits, late registrations by the rejected runtime added nothing.
      expect(s.registrations).toHaveLength(lifecycle ? 7 : 5)
    }
  )

  test('falls back to the bundled copy when reading the runtime throws', async () => {
    const s = setup(tracked, {
      [usRuntime]: `self.__cioWebPushRuntime = {
        api: 1,
        get version() { throw new Error('broken getter') },
        install() {},
      }`,
    })
    expectOneHandlerSet(s)
    await expectWorking(s)
  })

  test.each([
    ['and throws', "throw new Error('broken runtime')"],
    ['without throwing', ''],
  ])(
    'ignores listeners the runtime adds while it is evaluated, %s',
    async (_, after) => {
      const s = setup(tracked, {
        [usRuntime]:
          runtimeAt(nextPatch(bundled)) +
          `;self.addEventListener('push', () => {});${after}`,
      })
      expect(s.self).not.toHaveProperty('installed')
      expectOneHandlerSet(s)
      await expectWorking(s)
      expect(s.showNotification).toHaveBeenCalledTimes(1)
      // The global addEventListener is restored after the import.
      expect(Object.keys(s.self)).toContain('addEventListener')
    }
  )

  test('falls back to the bundled copy when the import throws', async () => {
    const s = setup(tracked, {
      [usRuntime]: "self.__cioWebPushRuntime = {}; throw new Error('syntax')",
    })
    expect(s.importScripts).toHaveBeenCalledTimes(1)
    expectOneHandlerSet(s)
    expect(s.self).not.toHaveProperty('__cioWebPushRuntime')
    await expectWorking(s)
  })

  test('never imports with runtime=off', async () => {
    const s = setup(
      `${tracked}&runtime=off`,
      // Present but unused: off means zero external fetches.
      { [usRuntime]: runtimeAt(nextPatch(bundled)) }
    )
    expect(s.importScripts).not.toHaveBeenCalled()
    expect(s.self).not.toHaveProperty('installed')
    expectOneHandlerSet(s)
    await expectWorking(s)
  })

  test.each([
    ['https://cdn.example.net/cio-webpush-sw-runtime.v1.js'],
    ['/cio/cio-webpush-sw-runtime.v1.js'],
  ])('imports a custom runtime URL %s', async (runtime) => {
    const resolved = new URL(runtime, 'https://example.com/').href
    const s = setup(`${tracked}&runtime=${encodeURIComponent(runtime)}`, {
      [resolved]: runtimeAt(nextPatch(bundled)),
    })
    expect(s.importScripts).toHaveBeenCalledTimes(1)
    expect(s.importScripts).toHaveBeenCalledWith(resolved)
    expect(s.self).toHaveProperty('installed', nextPatch(bundled))
    await expectWorking(s)
  })

  test.each(['javascript:alert(1)', 'data:text/javascript,0', 'http://['])(
    'ignores an unusable runtime URL %s',
    async (runtime) => {
      const s = setup(`${tracked}&runtime=${encodeURIComponent(runtime)}`)
      expect(s.importScripts).not.toHaveBeenCalled()
      expectOneHandlerSet(s)
      await expectWorking(s)
    }
  )

  test.each([
    ['track-eu.customer.io', 'https://track-eu.customer.io', euRuntime],
    ['track.customer.io', 'https://track.customer.io', usRuntime],
    ['a proxied track host', 'https://metrics.example.com/cio', usRuntime],
    ['no track host', undefined, usRuntime],
  ])('defaults the runtime region from %s', (_, track, expected) => {
    const s = setup(
      track ? workerUrl(`track=${encodeURIComponent(track)}`) : workerUrl('')
    )
    expect(s.importScripts).toHaveBeenCalledWith(expected)
  })

  test('a newer runtime honors the lifecycle opt-out', () => {
    const s = createWorker(
      worker,
      tracked,
      { cioWebPushLifecycle: false },
      undefined,
      {},
      { [usRuntime]: runtimeAt(nextPatch(bundled)) }
    )
    expect(s.self).toHaveProperty('installed', nextPatch(bundled))
    expect(s.registrations.map(([type]) => type).sort()).toEqual(
      handlers.filter((type) => !['install', 'activate'].includes(type)).sort()
    )
  })

  test('evaluating the runtime by itself installs nothing', () => {
    const s = createWorker(worker, tracked, { __cioWebPushImporting: true })
    expect(s.importScripts).not.toHaveBeenCalled()
    expect(s.registrations).toEqual([])
    expect(s.self).toHaveProperty(
      '__cioWebPushRuntime',
      expect.objectContaining({ api: 1, version: bundled })
    )
  })

  test('the bundled version matches the package version', () => {
    const pkg = path.join(__dirname, '../../../../package.json')
    expect(bundled).toBe(JSON.parse(fs.readFileSync(pkg, 'utf8')).version)
  })
})

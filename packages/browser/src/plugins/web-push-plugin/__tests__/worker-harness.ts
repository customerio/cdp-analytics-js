import fs from 'fs'
import path from 'path'
import v8 from 'v8'
import vm from 'vm'
import { IDBFactory } from 'fake-indexeddb'

// CI runs Node 14; fake-indexeddb calls these Node 17+ globals at runtime.
const objectWithHasOwn = Object as ObjectConstructor & {
  hasOwn?: (o: object, key: PropertyKey) => boolean
}
if (!objectWithHasOwn.hasOwn) {
  objectWithHasOwn.hasOwn = (o, key) =>
    Object.prototype.hasOwnProperty.call(o, key)
}
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (<T>(value: T): T =>
    v8.deserialize(v8.serialize(value))) as typeof structuredClone
}

// The build ships this file unchanged; test the exact service worker source.
export const worker = path.join(__dirname, '../cio-webpush-sw.js')

export function createWorker(
  worker: string,
  workerUrl = 'https://example.com/cio-webpush-sw.js?track=https%3A%2F%2Ftrack.customer.io',
  globals: Record<string, unknown> = {},
  indexedDB = new IDBFactory(),
  runtime: Record<string, unknown> = {}
) {
  const listeners: Record<string, (event: any) => void> = {}
  const fetch = jest.fn().mockResolvedValue({ ok: true })
  const showNotification = jest.fn().mockResolvedValue(undefined)
  const openWindow = jest.fn().mockResolvedValue(undefined)
  const postMessage = jest.fn()
  const pushManager = {
    getSubscription: jest.fn().mockResolvedValue({ endpoint: 'endpoint' }),
    subscribe: jest.fn().mockResolvedValue({}),
  }
  const skipWaiting = jest.fn().mockResolvedValue(undefined)
  const claim = jest.fn().mockResolvedValue(undefined)
  const sync = { register: jest.fn().mockResolvedValue(undefined) }
  const self = {
    ...globals,
    skipWaiting,
    location: { href: workerUrl, origin: new URL(workerUrl).origin },
    addEventListener: (name: string, fn: (event: any) => void) => {
      listeners[name] = fn
    },
    registration: { showNotification, pushManager, sync },
    clients: {
      claim,
      openWindow,
      matchAll: jest.fn().mockResolvedValue([{ postMessage }]),
    },
  }
  const warn = jest.fn()
  const context = vm.createContext({
    self,
    fetch,
    indexedDB,
    URL,
    Date,
    AbortSignal: { timeout: jest.fn(() => 'timeout-signal') },
    console: { warn },
    ...runtime,
  })
  // Model a host worker with names that would collide without the IIFE.
  vm.runInContext('let retryMetrics, metricTasks, trackUrl, metric;', context)
  const startup: Promise<unknown> = vm.runInContext(
    fs.readFileSync(worker, 'utf8'),
    context
  )
  const invoke = (name: string, event: any) => {
    const tasks: Promise<unknown>[] = []
    listeners[name]?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => {
        tasks.push(promise)
      },
    })
    return Promise.all(tasks)
  }
  return {
    invoke,
    skipWaiting,
    claim,
    fetch,
    showNotification,
    openWindow,
    postMessage,
    pushManager,
    indexedDB,
    sync,
    startup,
    warn,
  }
}

export async function readMetrics(indexedDB: IDBFactory): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('cio-webpush-metrics', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const request = db.transaction('events').objectStore('events').getAll()
      request.onsuccess = () => {
        resolve(request.result)
        db.close()
      }
      request.onerror = () => reject(request.error)
    }
  })
}

// Writes outbox records directly; each worker event rereads the whole outbox,
// so building a large one through events is quadratic and slow on Node 14.
export async function seedMetrics(
  indexedDB: IDBFactory,
  records: any[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('cio-webpush-metrics', 1)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const transaction = db.transaction('events', 'readwrite')
      const store = transaction.objectStore('events')
      records.forEach((record) => store.put(record))
      transaction.oncomplete = () => {
        db.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
  })
}

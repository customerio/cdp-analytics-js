/** @jest-environment node */
import { createWorker, worker } from './worker-harness'

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(1700000000000))
afterEach(() => jest.restoreAllMocks())

const workerUrl = (track?: string) =>
  'https://example.com/cio-webpush-sw.js' +
  (track ? `?track=${encodeURIComponent(track)}` : '')

const markers = {
  'CIO-Delivery-ID': 'delivery',
  'CIO-Delivery-Token': 'endpoint',
}

async function push(track: string | undefined, trackUrl?: unknown) {
  const s = createWorker(worker, workerUrl(track))
  await s.startup
  await s.invoke('push', {
    data: {
      json: () => ({
        title: 'Title',
        ...markers,
        ...(trackUrl !== undefined ? { track_url: trackUrl } : {}),
      }),
    },
  })
  return s
}

const urls = (s: Awaited<ReturnType<typeof push>>) =>
  s.fetch.mock.calls.map(([url]: [string]) => url)

describe('metric URL selection', () => {
  const us = 'https://track.customer.io'
  const eu = 'https://track-eu.customer.io'

  test('a proxy in ?track= wins over the payload track_url', async () => {
    const s = await push('https://proxy.example.com/cio', eu)
    expect(urls(s)).toEqual(['https://proxy.example.com/cio/push/events'])
  })

  test('our US host in ?track= loses to an EU payload track_url', async () => {
    const s = await push(us, eu)
    expect(urls(s)).toEqual([`${eu}/push/events`])
  })

  test('our EU host in ?track= loses to a US payload track_url', async () => {
    const s = await push(eu, us)
    expect(urls(s)).toEqual([`${us}/push/events`])
  })

  test('a missing ?track= works with a payload track_url', async () => {
    const s = await push(undefined, eu)
    expect(urls(s)).toEqual([`${eu}/push/events`])
  })

  test('a payload without track_url falls back to ?track=', async () => {
    const s = await push(us)
    expect(urls(s)).toEqual([`${us}/push/events`])
  })

  test('a non-https track_url is ignored', async () => {
    for (const bad of [
      'http://track-eu.customer.io',
      'javascript:1',
      'nope',
      5,
    ]) {
      const s = await push(us, bad)
      expect(urls(s)).toEqual([`${us}/push/events`])
    }
  })

  test('nothing is reported without ?track= or a valid track_url', async () => {
    const s = await push(undefined, 'http://track-eu.customer.io')
    expect(s.fetch).not.toHaveBeenCalled()
  })

  test('the click path reports opened to the track_url kept in notification data', async () => {
    const s = createWorker(worker, workerUrl(us))
    await s.startup
    await s.invoke('push', {
      data: { json: () => ({ title: 'T', ...markers, track_url: eu }) },
    })
    const { data } = s.showNotification.mock.calls[0][1]
    expect(data.track_url).toBe(eu)
    s.fetch.mockClear()
    await s.invoke('notificationclick', {
      notification: { close: jest.fn(), data },
    })
    expect(urls(s)).toEqual([`${eu}/push/events`])
    expect(JSON.parse(s.fetch.mock.calls[0][1].body).event).toBe('opened')
  })

  test('a click on a notification without track_url uses ?track=', async () => {
    const s = createWorker(worker, workerUrl(us))
    await s.invoke('notificationclick', {
      notification: {
        close: jest.fn(),
        data: { delivery_id: 'delivery', device_id: 'endpoint' },
      },
    })
    expect(urls(s)).toEqual([`${us}/push/events`])
  })
})

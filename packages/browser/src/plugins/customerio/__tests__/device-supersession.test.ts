import { Context } from '../../../core/context'
import { deviceSupersession } from '../device-supersession'

const device = (
  event: string,
  id: string,
  time = 1000,
  token = 'endpoint',
  seq?: number
) =>
  new Context(
    {
      type: 'track',
      event,
      timestamp: new Date(time),
      context: {
        device: {
          type: 'web',
          token,
          ...(seq ? { webpush_seq: seq, webpush_event_ms: time } : {}),
        },
      },
    },
    id
  )

beforeEach(() => localStorage.clear())

test('cancels known ties and older unseen retries, but allows fresh same-millisecond registrations', () => {
  const state = deviceSupersession()
  const created = device('Device Created or Updated', 'old')
  const deleted = device('Device Deleted', 'delete')
  const cancel = jest.fn((predicate: (ctx: Context) => boolean) =>
    [created].filter(predicate)
  )
  state.supersede(deleted, cancel)
  expect(state.stale(created)).toBe(true)
  expect(
    state.stale(device('Device Created or Updated', 'older-unseen', 999))
  ).toBe(true)
  const fresh = device('Device Created or Updated', 'new')
  expect(state.stale(fresh)).toBe(false)
  expect(
    state.stale(
      device('Device Created or Updated', 'other', 999, 'other-endpoint')
    )
  ).toBe(false)
  const reloaded = deviceSupersession()
  expect(
    reloaded.stale(
      new Context(JSON.parse(JSON.stringify(created.event)), created.id)
    )
  ).toBe(true)
  reloaded.supersede(deleted, cancel)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(reloaded.stale(fresh)).toBe(false)
})

test('sequence orders unseen same-millisecond retries and wins over rewritten timestamps', () => {
  const state = deviceSupersession()
  const old = device('Device Created or Updated', 'old', 1000, 'endpoint', 1)
  const fresh = device('Device Created or Updated', 'fresh', 999, 'endpoint', 3)
  const cancel = jest.fn((predicate: (ctx: Context) => boolean) =>
    [old, fresh].filter(predicate)
  )
  state.supersede(
    device('Device Deleted', 'delete', 1000, 'endpoint', 2),
    cancel
  )
  expect(cancel.mock.results[0].value).toEqual([old])
  expect(
    state.stale(
      device('Device Created or Updated', 'unseen', 1000, 'endpoint', 1)
    )
  ).toBe(true)
  expect(state.stale(fresh)).toBe(false)
  const reloaded = deviceSupersession()
  expect(reloaded.stale(fresh)).toBe(false)
  reloaded.supersede(
    device('Device Deleted', 'retry', 2000, 'endpoint', 1),
    cancel
  )
  expect(cancel).toHaveBeenCalledTimes(1)
})

test('retrying a strictly older delete never supersedes a newer registration', () => {
  const state = deviceSupersession()
  const cancel = jest.fn(() => [])
  state.supersede(device('Device Deleted', 'new-delete', 2000), cancel)
  state.supersede(device('Device Deleted', 'old-delete', 1000), cancel)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(
    state.stale(device('Device Created or Updated', 'new-create', 2001))
  ).toBe(false)
})

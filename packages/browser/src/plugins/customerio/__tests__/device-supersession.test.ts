import { Context } from '../../../core/context'
import { deviceSupersession } from '../device-supersession'

const device = (event: string, id: string, time = 1000, token = 'endpoint') =>
  new Context(
    {
      type: 'track',
      event,
      timestamp: new Date(time),
      context: { device: { type: 'web', token } },
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

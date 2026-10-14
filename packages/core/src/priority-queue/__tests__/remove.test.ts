import { PriorityQueue } from '..'

test('removes queued and backing-off items without resurrecting them', () => {
  jest.useFakeTimers({ doNotFake: ['performance'] })
  const cancelled = { id: 'cancelled' }
  const ready = { id: 'ready' }
  const kept = { id: 'kept' }
  const queue = new PriorityQueue<{ id: string }>(10, [])
  queue.push(cancelled)
  queue.pop()
  queue.pushWithBackoff(cancelled)
  queue.push(ready, kept)
  expect(queue.remove((item) => item.id !== kept.id)).toEqual([
    ready,
    cancelled,
  ])
  expect(queue.todo).toBe(1)
  jest.runAllTimers()
  expect(queue.pop()).toBe(kept)
  expect(queue.todo).toBe(0)
  jest.useRealTimers()
})

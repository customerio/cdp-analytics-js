import { CustomerioEvent } from '../../core/events'
import { fetch } from '../../lib/fetch'
import { onPageLeave } from '../../lib/on-page-leave'
import { isRetryableStatus } from './fetch-dispatcher'

export type BatchingDispatchConfig = {
  size?: number
  timeout?: number
}

const MAX_PAYLOAD_SIZE = 500

function kilobytes(buffer: unknown): number {
  const size = encodeURI(JSON.stringify(buffer)).split(/%..|./).length - 1
  return size / 1024
}

/**
 * Checks if the payload is over or close to
 * the maximum payload size allowed by tracking
 * API.
 */
function approachingTrackingAPILimit(buffer: unknown): boolean {
  return kilobytes(buffer) >= MAX_PAYLOAD_SIZE - 50
}

function chunks(batch: object[]): Array<object[]> {
  const result: object[][] = []
  let index = 0

  batch.forEach((item) => {
    const size = kilobytes(result[index])
    if (size >= 64) {
      index++
    }

    if (result[index]) {
      result[index].push(item)
    } else {
      result[index] = [item]
    }
  })

  return result
}

export default function batch(remote: string, config?: BatchingDispatchConfig) {
  let buffer: object[] = []
  let pageUnloaded = false
  // `dispatch` resolves before the batch is sent, so a failed batch reports
  // each of its events through the `onRetry` callback given with that event.
  const retries = new WeakMap<object, () => void>()

  const limit = config?.size ?? 10
  const timeout = config?.timeout ?? 5000

  function sendBatch(batch: object[]) {
    if (batch.length === 0) {
      return
    }

    const writeKey = (batch[0] as CustomerioEvent)?.writeKey

    return fetch(`${remote}/b`, {
      keepalive: pageUnloaded,
      headers: {
        'Content-Type': 'text/plain',
      },
      method: 'post',
      body: JSON.stringify({ batch, writeKey }),
    })
      .then((res) => {
        if (isRetryableStatus(res.status)) {
          throw new Error(`Retryable response from server: ${res.status}`)
        }
        batch.forEach((event) => retries.delete(event))
      })
      .catch(() => {
        // The API answers for the whole batch, so every event in it is retried.
        // Each callback is removed before it runs, so it runs at most once.
        batch.forEach((event) => {
          const onRetry = retries.get(event)
          retries.delete(event)
          onRetry?.()
        })
      })
  }

  async function flush(): Promise<unknown> {
    if (buffer.length) {
      const batch = buffer
      buffer = []
      return sendBatch(batch)
    }
  }

  let schedule: NodeJS.Timeout | undefined

  function scheduleFlush(): void {
    if (schedule) {
      return
    }

    schedule = setTimeout(() => {
      schedule = undefined
      flush().catch(console.error)
    }, timeout)
  }

  onPageLeave(() => {
    pageUnloaded = true

    // Take the events out of the buffer, as `flush` does, so the scheduled
    // flush can't send them a second time after a tab is hidden.
    if (schedule) {
      clearTimeout(schedule)
      schedule = undefined
    }

    if (buffer.length) {
      const pending = buffer
      buffer = []
      const reqs = chunks(pending).map(sendBatch)
      Promise.all(reqs).catch(console.error)
    }
  })

  async function dispatch(
    _url: string,
    body: object,
    onRetry?: () => void
  ): Promise<unknown> {
    if (onRetry) retries.set(body, onRetry)
    buffer.push(body)

    const bufferOverflow =
      buffer.length >= limit || approachingTrackingAPILimit(buffer)

    return bufferOverflow || pageUnloaded ? flush() : scheduleFlush()
  }

  return {
    dispatch,
  }
}

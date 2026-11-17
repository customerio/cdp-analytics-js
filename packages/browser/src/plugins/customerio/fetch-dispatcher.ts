import { fetch } from '../../lib/fetch'

/**
 * Sends one request. The promise rejects when the request should be sent
 * again: on a network error or a retryable status (see `isRetryableStatus`).
 * Batching dispatchers resolve before the request is made, so they report
 * those failures for each event through `onRetry` instead.
 */
export type Dispatcher = (
  url: string,
  body: object,
  onRetry?: () => void
) => Promise<unknown>

export type StandardDispatcherConfig = {
  keepalive?: boolean
}

/**
 * Server errors, request timeouts and rate limiting are worth sending again.
 * Other 4xx statuses mean the API refused the request, so a resend would fail
 * the same way.
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

export default function (config?: StandardDispatcherConfig): {
  dispatch: Dispatcher
} {
  function dispatch(url: string, body: object): Promise<unknown> {
    return fetch(url, {
      keepalive: config?.keepalive,
      headers: { 'Content-Type': 'text/plain' },
      method: 'post',
      body: JSON.stringify(body),
    }).then((res) => {
      if (isRetryableStatus(res.status)) {
        throw new Error(`Retryable response from server: ${res.status}`)
      }
      return res
    })
  }

  return {
    dispatch,
  }
}

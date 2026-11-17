const fetch = jest.fn()

jest.mock('unfetch', () => {
  return fetch
})

import batch from '../batched-dispatcher'

const fatEvent = {
  _id: '609c0e91fe97b680e384d6e4',
  index: 5,
  guid: 'ca7fac24-41c9-45db-bc53-59b544e43943',
  isActive: false,
  balance: '$2,603.43',
  picture: 'http://placehold.it/32x32',
  age: 36,
  eyeColor: 'blue',
  name: 'Myers Hoover',
  gender: 'male',
  company: 'SILODYNE',
  email: 'myershoover@silodyne.com',
  phone: '+1 (986) 580-3562',
  address: '240 Ryder Avenue, Belva, Nebraska, 929',
  about:
    'Non eu nulla exercitation consectetur reprehenderit culpa mollit non consectetur magna tempor. Do et duis occaecat eu culpa dolor elit et est pariatur qui. Veniam dolore amet minim veniam quis esse. Aute commodo sint officia velit dolor. Sit enim nisi eu exercitation dolore nulla dolor occaecat. Sunt eu pariatur reprehenderit ipsum et nulla cillum culpa ea.\r\n',
  registered: '2019-04-13T09:29:21 +05:00',
  latitude: 68.879515,
  longitude: -46.670697,
  tags: ['magna', 'ex', 'nostrud', 'mollit', 'laborum', 'exercitation', 'sit'],
  friends: [
    {
      id: 0,
      name: 'Lynn Brock',
    },
    {
      id: 1,
      name: 'May Hull',
    },
    {
      id: 2,
      name: 'Elena Henderson',
    },
  ],
  greeting: 'Hello, Myers Hoover! You have 5 unread messages.',
  favoriteFruit: 'strawberry',
}

// Settles promise callbacks while jest's fake timers are installed.
const flushPromises = (): Promise<void> =>
  new Promise((resolve) => jest.requireActual('timers').setImmediate(resolve))

describe('Batching', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    jest.restoreAllMocks()
    jest.useFakeTimers()
    fetch.mockResolvedValue({ ok: true, status: 200 })
  })

  afterEach(() => {
    // clear any pending sendBatch calls
    jest.runAllTimers()
    jest.useRealTimers()
  })

  it('does not send requests right away', async () => {
    const { dispatch } = batch(`https://cdp.customer.io`)

    await dispatch(`https://cdp.customer.io/v1/t`, {
      hello: 'world',
    })

    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends requests after a batch limit is hit', async () => {
    const { dispatch } = batch(`https://cdp.customer.io`, {
      size: 3,
    })

    await dispatch(`https://cdp.customer.io/v1/t`, {
      event: 'first',
    })
    expect(fetch).not.toHaveBeenCalled()

    await dispatch(`https://cdp.customer.io/v1/t`, {
      event: 'second',
    })
    expect(fetch).not.toHaveBeenCalled()

    await dispatch(`https://cdp.customer.io/v1/t`, {
      event: 'third',
    })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]).toMatchInlineSnapshot(`
      Array [
        "https://cdp.customer.io/b",
        Object {
          "body": "{\\"batch\\":[{\\"event\\":\\"first\\"},{\\"event\\":\\"second\\"},{\\"event\\":\\"third\\"}]}",
          "headers": Object {
            "Content-Type": "text/plain",
          },
          "keepalive": false,
          "method": "post",
        },
      ]
    `)
  })

  it('sends requests if the size of events exceeds tracking API limits', async () => {
    const { dispatch } = batch(`https://cdp.customer.io`, {
      size: 600,
    })

    // fatEvent is about ~1kb in size
    for (let i = 0; i < 250; i++) {
      await dispatch(`https://cdp.customer.io/v1/t`, {
        event: 'fat event',
        properties: fatEvent,
      })
    }
    expect(fetch).not.toHaveBeenCalled()

    for (let i = 0; i < 250; i++) {
      await dispatch(`https://cdp.customer.io/v1/t`, {
        event: 'fat event',
        properties: fatEvent,
      })
    }

    // still called, even though our batch limit is 600 events
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('sends requests when the timeout expires', async () => {
    const { dispatch } = batch(`https://cdp.customer.io`, {
      size: 100,
      timeout: 10000, // 10 seconds
    })

    await dispatch(`https://cdp.customer.io/v1/t`, {
      event: 'first',
    })
    expect(fetch).not.toHaveBeenCalled()

    await dispatch(`https://cdp.customer.io/v1/i`, {
      event: 'second',
    })

    jest.advanceTimersByTime(11000) // 11 seconds

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]).toMatchInlineSnapshot(`
      Array [
        "https://cdp.customer.io/b",
        Object {
          "body": "{\\"batch\\":[{\\"event\\":\\"first\\"},{\\"event\\":\\"second\\"}]}",
          "headers": Object {
            "Content-Type": "text/plain",
          },
          "keepalive": false,
          "method": "post",
        },
      ]
    `)
  })

  it('clears the buffer between flushes', async () => {
    const { dispatch } = batch(`https://cdp.customer.io`, {
      size: 100,
      timeout: 10000, // 10 seconds
    })

    await dispatch(`https://cdp.customer.io/v1/t`, {
      event: 'first',
    })

    jest.advanceTimersByTime(11000) // 11 seconds

    await dispatch(`https://cdp.customer.io/v1/i`, {
      event: 'second',
    })

    jest.advanceTimersByTime(11000) // 11 seconds

    expect(fetch).toHaveBeenCalledTimes(2)

    expect(fetch.mock.calls[0]).toMatchInlineSnapshot(`
      Array [
        "https://cdp.customer.io/b",
        Object {
          "body": "{\\"batch\\":[{\\"event\\":\\"first\\"}]}",
          "headers": Object {
            "Content-Type": "text/plain",
          },
          "keepalive": false,
          "method": "post",
        },
      ]
    `)

    expect(fetch.mock.calls[1]).toMatchInlineSnapshot(`
      Array [
        "https://cdp.customer.io/b",
        Object {
          "body": "{\\"batch\\":[{\\"event\\":\\"second\\"}]}",
          "headers": Object {
            "Content-Type": "text/plain",
          },
          "keepalive": false,
          "method": "post",
        },
      ]
    `)
  })

  describe('on unload', () => {
    it('flushes the batch', async () => {
      const { dispatch } = batch(`https://cdp.customer.io`)

      dispatch(`https://cdp.customer.io/v1/t`, {
        hello: 'world',
      }).catch(console.error)

      dispatch(`https://cdp.customer.io/v1/t`, {
        bye: 'world',
      }).catch(console.error)

      expect(fetch).not.toHaveBeenCalled()

      window.dispatchEvent(new Event('pagehide'))

      expect(fetch).toHaveBeenCalledTimes(1)

      // any dispatch attempts after the page has unloaded are flushed immediately
      // this can happen if analytics.track is called right before page is navigated away
      dispatch(`https://cdp.customer.io/v1/t`, {
        afterlife: 'world',
      }).catch(console.error)

      // no queues, no waiting, instatneous
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('flushes in batches of no more than 64kb', async () => {
      const { dispatch } = batch(`https://cdp.customer.io`, {
        size: 1000,
      })

      // fatEvent is about ~1kb in size
      for (let i = 0; i < 80; i++) {
        await dispatch(`https://cdp.customer.io/v1/t`, {
          event: 'fat event',
          properties: fatEvent,
        })
      }

      expect(fetch).not.toHaveBeenCalled()

      window.dispatchEvent(new Event('pagehide'))

      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('asks to retry events in a batch the API did not accept', async () => {
      fetch.mockResolvedValue({ ok: false, status: 503 })
      const { dispatch } = batch(`https://cdp.customer.io`)
      const onRetry = jest.fn()

      await dispatch(
        `https://cdp.customer.io/v1/t`,
        { hello: 'world' },
        onRetry
      )
      window.dispatchEvent(new Event('pagehide'))
      await flushPromises()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(onRetry).toHaveBeenCalledTimes(1)
    })
  })

  describe('retries', () => {
    it.each([500, 502, 503, 408, 429])(
      'asks to retry every event in a batch answered with %i',
      async (status) => {
        fetch.mockResolvedValue({ ok: false, status })
        const { dispatch } = batch(`https://cdp.customer.io`, { size: 2 })
        const first = jest.fn()
        const second = jest.fn()

        await dispatch(`https://cdp.customer.io/v1/t`, { event: '1' }, first)
        expect(first).not.toHaveBeenCalled()
        await dispatch(`https://cdp.customer.io/v1/t`, { event: '2' }, second)

        expect(fetch).toHaveBeenCalledTimes(1)
        expect(first).toHaveBeenCalledTimes(1)
        expect(second).toHaveBeenCalledTimes(1)
      }
    )

    it('asks to retry every event in a batch that failed to send', async () => {
      fetch.mockRejectedValue(new TypeError('Failed to fetch'))
      const { dispatch } = batch(`https://cdp.customer.io`, { size: 2 })
      const first = jest.fn()
      const second = jest.fn()

      await dispatch(`https://cdp.customer.io/v1/t`, { event: '1' }, first)
      await dispatch(`https://cdp.customer.io/v1/t`, { event: '2' }, second)

      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
    })

    it.each([200, 400, 401, 404, 413])(
      'does not retry a batch answered with %i',
      async (status) => {
        fetch.mockResolvedValue({ ok: status < 300, status })
        const { dispatch } = batch(`https://cdp.customer.io`, { size: 2 })
        const onRetry = jest.fn()

        await dispatch(`https://cdp.customer.io/v1/t`, { event: '1' }, onRetry)
        await dispatch(`https://cdp.customer.io/v1/t`, { event: '2' }, onRetry)

        expect(fetch).toHaveBeenCalledTimes(1)
        expect(onRetry).not.toHaveBeenCalled()
      }
    )

    it('asks to retry a batch sent when the timeout expires', async () => {
      fetch.mockResolvedValue({ ok: false, status: 500 })
      const { dispatch } = batch(`https://cdp.customer.io`, {
        size: 100,
        timeout: 10000,
      })
      const onRetry = jest.fn()

      await dispatch(`https://cdp.customer.io/v1/t`, { event: '1' }, onRetry)
      jest.advanceTimersByTime(11000)
      await flushPromises()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(onRetry).toHaveBeenCalledTimes(1)
    })

    it('only retries the events of the batch that failed', async () => {
      fetch
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true, status: 200 })
      const { dispatch } = batch(`https://cdp.customer.io`, { size: 1 })
      const failed = jest.fn()
      const delivered = jest.fn()

      await dispatch(`https://cdp.customer.io/v1/t`, { event: '1' }, failed)
      await dispatch(`https://cdp.customer.io/v1/t`, { event: '2' }, delivered)

      expect(fetch).toHaveBeenCalledTimes(2)
      expect(failed).toHaveBeenCalledTimes(1)
      expect(delivered).not.toHaveBeenCalled()
    })
  })
})

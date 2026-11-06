import { FutureRoundError, RetiNotDeployedError, TimeTravelUnavailableError } from 'reti-ghost-sdk'
import {
  causes,
  httpStatusOf,
  isFinalReadError,
  isRetriedByClient,
  nodeMessageOf,
  readFailureMessage,
  retryRead,
  retryReadDelay,
} from '@/utils/readErrors'

/** An error shaped like algosdk's HTTPClient errors: `status`, and the node's JSON body as text. */
function httpError(status: number, message = 'failed'): Error {
  return Object.assign(new Error(`Network request error. Received status ${status}`), {
    status,
    response: { status, text: JSON.stringify({ message }) },
  })
}

/** An error wrapping another, as ghostkit's GhostkitError and the SDK's DTUnsupportedError do. */
function wrapped(cause: unknown, name = 'GhostkitError'): Error {
  return Object.assign(new Error('ghostkit: getValidators failed'), { name, cause })
}

const busy = () => httpError(503, 'the node is busy: try again later or on another node')
const historyUnavailable = () => httpError(503, 'the box index is incomplete')

describe('causes', () => {
  it('walks the cause chain', () => {
    const inner = new Error('inner')
    const outer = wrapped(inner)
    expect(causes(outer)).toEqual([outer, inner])
  })

  it('stops at a self-referencing cause and at five levels', () => {
    const self = new Error('self') as Error & { cause?: unknown }
    self.cause = self
    expect(causes(self)).toEqual([self])

    let deep: unknown = new Error('0')
    for (let i = 1; i < 6; i++) deep = wrapped(deep)
    expect(causes(deep)).toHaveLength(5)
  })
})

describe('httpStatusOf', () => {
  it('finds the status through the chain, or in an axios-style response', () => {
    expect(httpStatusOf(wrapped(httpError(404)))).toBe(404)
    expect(httpStatusOf({ response: { status: 429 } })).toBe(429)
    expect(httpStatusOf(new Error('no status'))).toBeUndefined()
  })
})

describe('isFinalReadError', () => {
  it('is final for client errors other than 408 and 429', () => {
    expect(isFinalReadError(httpError(400))).toBe(true)
    expect(isFinalReadError(httpError(404))).toBe(true)
    expect(isFinalReadError(httpError(408))).toBe(false)
    expect(isFinalReadError(httpError(429))).toBe(false)
  })

  it('is final for history the node cannot serve and for its time limit', () => {
    expect(isFinalReadError(historyUnavailable())).toBe(true)
    expect(isFinalReadError(httpError(504))).toBe(true)
  })

  it('is not final for a busy node or other server errors', () => {
    expect(isFinalReadError(busy())).toBe(false)
    expect(isFinalReadError(httpError(500))).toBe(false)
    expect(isFinalReadError(httpError(502))).toBe(false)
  })

  it('looks through wrappers', () => {
    expect(isFinalReadError(wrapped(httpError(400)))).toBe(true)
    expect(isFinalReadError(wrapped(wrapped(historyUnavailable())))).toBe(true)
    expect(isFinalReadError(wrapped(busy()))).toBe(false)
  })

  it('is final for unsupported features and cancelled reads, by name', () => {
    expect(isFinalReadError(wrapped(undefined, 'DTUnsupportedError'))).toBe(true)
    expect(isFinalReadError(wrapped(undefined, 'DTNotAvailableError'))).toBe(true)
    expect(isFinalReadError(new DOMException('The operation was aborted.', 'AbortError'))).toBe(
      true,
    )
  })

  it('is not final for a network error', () => {
    expect(isFinalReadError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isFinalReadError(new Error('network'))).toBe(false)
  })
})

describe('retryRead', () => {
  it("retries a failed read, but not a round that can't be shown", () => {
    expect(retryRead(0, new Error('network'))).toBe(true)
    expect(retryRead(3, new Error('network'))).toBe(false)
    expect(retryRead(0, new FutureRoundError(100n, 90n))).toBe(false)
    expect(retryRead(0, new TimeTravelUnavailableError(10n, 90n, 'stock'))).toBe(false)
    expect(retryRead(0, new RetiNotDeployedError(10n, 50n))).toBe(false)
  })

  it("doesn't retry a failure another try can't change", () => {
    expect(retryRead(0, httpError(400))).toBe(false)
    expect(retryRead(0, wrapped(historyUnavailable()))).toBe(false)
    expect(retryRead(0, httpError(504))).toBe(false)
  })

  it('retries a network error, a busy node and other server errors once: the client already did', () => {
    expect(retryRead(0, new TypeError('Failed to fetch'))).toBe(true)
    expect(retryRead(1, new TypeError('Failed to fetch'))).toBe(false)
    expect(retryRead(0, wrapped(busy()))).toBe(true)
    expect(retryRead(1, wrapped(busy()))).toBe(false)
    expect(retryRead(0, httpError(429))).toBe(true)
    expect(retryRead(1, httpError(502))).toBe(false)
  })

  it('retries a failure the client never saw three times', () => {
    expect(retryRead(2, new Error('batch load left out'))).toBe(true)
    expect(retryRead(3, new Error('batch load left out'))).toBe(false)
  })

  it("leaves a REST API's failures to the default count: its client retries by its own rules", () => {
    const axios = Object.assign(new Error('Request failed with status code 502'), {
      isAxiosError: true,
      response: { status: 502 },
    })
    expect(isRetriedByClient(axios)).toBe(false)
    expect(retryRead(2, axios)).toBe(true)
  })
})

describe('isRetriedByClient', () => {
  it('finds a retried status or network error through a wrapper', () => {
    expect(isRetriedByClient(wrapped(busy()))).toBe(true)
    expect(isRetriedByClient(wrapped(new TypeError('Failed to fetch')))).toBe(true)
    expect(isRetriedByClient(httpError(400))).toBe(false)
    expect(isRetriedByClient(new Error('network'))).toBe(false)
  })
})

describe('retryReadDelay', () => {
  it('waits as react-query would for a failure the client never saw', () => {
    expect(retryReadDelay(0, new Error('x'))).toBe(1000)
    expect(retryReadDelay(2, new Error('x'))).toBe(4000)
    expect(retryReadDelay(10, new Error('x'))).toBe(30_000)
  })

  it('waits at least 10 s after the client gave up, and as long as Retry-After asks', () => {
    expect(retryReadDelay(0, wrapped(busy()))).toBe(10_000)
    const limited = Object.assign(httpError(429), {
      response: { status: 429, text: '', headers: { 'retry-after': '45' } },
    })
    expect(retryReadDelay(0, wrapped(limited))).toBe(45_000)
    const longer = Object.assign(httpError(429), {
      response: { status: 429, text: '', headers: { 'retry-after': '3600' } },
    })
    expect(retryReadDelay(0, longer)).toBe(5 * 60_000)
  })
})

describe('readFailureMessage', () => {
  it('names each reason, through a wrapper', () => {
    expect(readFailureMessage(wrapped(new FutureRoundError(100n, 90n)))).toMatch(
      /hasn't happened yet/,
    )
    expect(readFailureMessage(wrapped(busy()))).toBe('The node is busy. Try again in a moment.')
    expect(readFailureMessage(wrapped(historyUnavailable()))).toBe(
      "The node can't serve this history right now.",
    )
    expect(readFailureMessage(wrapped(httpError(504)))).toBe(
      'This took longer than the node allows.',
    )
    expect(readFailureMessage(wrapped(httpError(400), 'DTUnsupportedError'))).toBe(
      "The read node doesn't support this.",
    )
    expect(readFailureMessage(wrapped(undefined, 'DTNotAvailableError'))).toBe(
      "The read node doesn't support this.",
    )
  })

  it('is undefined for anything else', () => {
    expect(readFailureMessage(new Error('boom'))).toBeUndefined()
    expect(readFailureMessage(httpError(500))).toBeUndefined()
  })
})

describe('nodeMessageOf', () => {
  it("finds the node's message through a wrapper", () => {
    expect(nodeMessageOf(wrapped(historyUnavailable()))).toBe('the box index is incomplete')
  })

  it('reads a decoded body when there is no text', () => {
    expect(nodeMessageOf({ response: { body: { message: 'bad round' } } })).toBe('bad round')
  })

  it('is undefined without a JSON message', () => {
    expect(nodeMessageOf(new Error('boom'))).toBeUndefined()
    expect(nodeMessageOf({ response: { text: 'not json' } })).toBeUndefined()
    expect(nodeMessageOf({ response: { text: '{"message":""}' } })).toBeUndefined()
  })

  it('shortens a long message', () => {
    const message = nodeMessageOf(httpError(400, 'x'.repeat(500)))
    expect(message).toHaveLength(200)
    expect(message?.endsWith('…')).toBe(true)
  })
})

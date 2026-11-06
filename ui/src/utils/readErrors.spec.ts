import { FutureRoundError, RetiNotDeployedError, TimeTravelUnavailableError } from 'reti-ghost-sdk'
import { causes, httpStatusOf, isFinalReadError, retryRead } from '@/utils/readErrors'

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

  it('retries a network error, a busy node and other server errors', () => {
    expect(retryRead(0, new TypeError('Failed to fetch'))).toBe(true)
    expect(retryRead(2, busy())).toBe(true)
    expect(retryRead(0, httpError(502))).toBe(true)
  })
})

import { AdaptiveBatchSize, isRateLimitError } from '@/utils/rateLimit'

const ALGOD_STORAGE_KEY = 'reti-batch-size:algod'

describe('isRateLimitError', () => {
  it('detects an axios style response', () => {
    expect(isRateLimitError({ response: { status: 429 } })).toBe(true)
    expect(isRateLimitError({ response: { status: 503 } })).toBe(true)
  })

  it('detects a bare status, as algosdk clients throw', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true)
  })

  it('detects it in a flattened message', () => {
    expect(isRateLimitError(new Error('Received status 429: Too Many Requests'))).toBe(true)
  })

  it("treats a busy node as load, but not history the node can't serve", () => {
    const busy = {
      status: 503,
      message: 'Received status 503',
      response: { status: 503, text: '{"message":"the node is busy: try again later"}' },
    }
    const history = {
      status: 503,
      message: 'Received status 503',
      response: { status: 503, text: '{"message":"the box index is incomplete"}' },
    }
    expect(isRateLimitError(busy)).toBe(true)
    expect(isRateLimitError(history)).toBe(false)
    expect(isRateLimitError(Object.assign(new Error('ghostkit: 503'), { cause: history }))).toBe(
      false,
    )
  })

  it('ignores everything else', () => {
    expect(isRateLimitError({ response: { status: 404 } })).toBe(false)
    expect(isRateLimitError(new Error('box not found'))).toBe(false)
    expect(isRateLimitError(null)).toBe(false)
    expect(isRateLimitError('429')).toBe(false)
  })
})

describe('AdaptiveBatchSize', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('starts at the host default', () => {
    expect(new AdaptiveBatchSize('algod').current).toBe(4)
  })

  it('probes upward only after sustained clean batches', () => {
    const rate = new AdaptiveBatchSize('algod')

    rate.recordClean()
    expect(rate.current).toBe(4)

    rate.recordClean()
    expect(rate.current).toBe(5)
  })

  it('never climbs past the host ceiling', () => {
    const rate = new AdaptiveBatchSize('algod')

    for (let i = 0; i < 100; i++) {
      rate.recordClean()
    }

    expect(rate.current).toBe(8)
  })

  it('halves on rate limiting but never stalls', () => {
    const rate = new AdaptiveBatchSize('algod')
    for (let i = 0; i < 100; i++) {
      rate.recordClean()
    }

    rate.recordThrottled()
    expect(rate.current).toBe(4)

    for (let i = 0; i < 20; i++) {
      rate.recordThrottled()
    }
    expect(rate.current).toBe(2)
  })

  it('resets its progress toward an increase when throttled', () => {
    const rate = new AdaptiveBatchSize('algod')

    rate.recordClean()
    rate.recordThrottled()
    rate.recordClean()

    expect(rate.current).toBe(2)
  })

  it('resumes from the rate it learned last load', () => {
    const first = new AdaptiveBatchSize('algod')
    first.recordThrottled()

    expect(window.localStorage.getItem(ALGOD_STORAGE_KEY)).toBe('2')
    expect(new AdaptiveBatchSize('algod').current).toBe(2)
  })

  it('clamps a corrupt or out of range stored value', () => {
    window.localStorage.setItem(ALGOD_STORAGE_KEY, '9999')
    expect(new AdaptiveBatchSize('algod').current).toBe(8)

    window.localStorage.setItem(ALGOD_STORAGE_KEY, 'not-a-number')
    expect(new AdaptiveBatchSize('algod').current).toBe(4)

    window.localStorage.setItem(ALGOD_STORAGE_KEY, '0')
    expect(new AdaptiveBatchSize('algod').current).toBe(4)
  })
})

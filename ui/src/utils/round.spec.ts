import {
  isPinnedQueryKey,
  keepAcrossRounds,
  parseRound,
  PINNED_GC_TIME,
  pinnedSignal,
  roundKey,
  roundQueryDefaults,
} from '@/utils/round'

describe('keepAcrossRounds', () => {
  const key = ['validator-state', '1', roundKey(50_000_000n)]
  type Keep = (data: unknown, query?: { queryKey: readonly unknown[] }) => unknown
  const keep = keepAcrossRounds<{ queryKey: string[]; placeholderData?: Keep }>({
    queryKey: key,
  }).placeholderData!

  it('keeps the same read at another round, or the latest', () => {
    expect(keep('old', { queryKey: ['validator-state', '1', roundKey(49_000_000n)] })).toBe('old')
    expect(keep('old', { queryKey: ['validator-state', '1', roundKey(undefined)] })).toBe('old')
  })

  it("doesn't keep another validator's data, or anything without a previous query", () => {
    expect(keep('old', { queryKey: ['validator-state', '2', roundKey(49_000_000n)] })).toBe(
      undefined,
    )
    expect(keep('old', undefined)).toBe(undefined)
  })
})

describe('roundKey / isPinnedQueryKey', () => {
  it('keys the latest state apart from any round', () => {
    expect(roundKey(undefined)).toBe('latest')
    expect(roundKey(50_000_000n)).not.toBe(roundKey(undefined))
    expect(roundKey(50_000_000n)).not.toBe(roundKey(50_000_001n))
  })

  it('recognises pinned keys by their last element', () => {
    expect(isPinnedQueryKey(['validator-state', '1', roundKey(50_000_000n)])).toBe(true)
    expect(isPinnedQueryKey(['validator-state', '1', roundKey(undefined)])).toBe(false)
  })

  it("doesn't mistake a trailing numeric id for a round", () => {
    expect(isPinnedQueryKey(['validator-metrics', '1'])).toBe(false)
    expect(isPinnedQueryKey(['nfd', '12345', { view: 'full' }])).toBe(false)
  })
})

describe('roundQueryDefaults', () => {
  const live = { staleTime: 30_000, refetchInterval: 30_000, gcTime: 600_000 }

  it('keeps the live options for the latest state', () => {
    expect(roundQueryDefaults(undefined, live)).toEqual(live)
  })

  it('never refetches a past round, and drops it sooner than live data', () => {
    expect(roundQueryDefaults(50_000_000n, { ...live, gcTime: 86_400_000 })).toEqual({
      gcTime: PINNED_GC_TIME,
      staleTime: Infinity,
      refetchInterval: false,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
    })
  })
})

describe('parseRound', () => {
  it('accepts positive integers as numbers, strings and bigints', () => {
    expect(parseRound(50_000_000)).toBe(50_000_000n)
    expect(parseRound('50000000')).toBe(50_000_000n)
    expect(parseRound(' 42 ')).toBe(42n)
    expect(parseRound(7n)).toBe(7n)
  })

  it('rejects anything else', () => {
    for (const value of [undefined, null, 0, -1, 1.5, '', 'abc', '1e6', '-5', 0n, NaN, {}]) {
      expect(parseRound(value)).toBeUndefined()
    }
  })
})

describe('pinnedSignal', () => {
  it("never reads a live query's signal, so it is never cancelled", () => {
    const signal = new AbortController().signal
    let reads = 0
    const context = {
      get signal() {
        reads++
        return signal
      },
    }
    expect(pinnedSignal(undefined, context)).toBeUndefined()
    expect(reads).toBe(0)
    expect(pinnedSignal(50_000_000n, context)).toBe(signal)
  })
})

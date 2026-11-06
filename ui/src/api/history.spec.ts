import { QueryClient } from '@tanstack/react-query'
import type { StakeEvent, StakerHistory, StakerHistoryOptions } from 'reti-ghost-sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  changeDescriptionsQueryOptions,
  mergeSeries,
  stakerHistoryQueryKey,
  stakerHistoryQueryOptions,
  type StakerHistoryData,
  stakerPoolsQueryKey,
  stakerPoolsQueryOptions,
  rangeApplies,
  type SeriesExtent,
  seriesExtentQueryOptions,
  seriesPartRounds,
  seriesWindowQueryOptions,
  totalsSeriesPartQueryOptions,
  type TotalsPoint,
} from '@/api/history'
import { roundTimes } from '@/api/roundTimes'
import { mockPoolState, mockSdk, mockTimestampAt, mockValidatorTotals } from '@/utils/tests/sdk'
import { PINNED_GC_TIME } from '@/utils/round'

vi.mock('@/api/reti', async () => (await import('@/utils/tests/sdk')).mockRetiModule())

const WINDOW = { start: 50_000_000n, end: 53_000_000n }

/** The part of a query function's context these queries read. */
const queryContext = (signal = new AbortController().signal) => ({ signal })

/** Runs a query's fetch outside React Query. */
async function fetchPart(...args: Parameters<typeof totalsSeriesPartQueryOptions>) {
  const options = totalsSeriesPartQueryOptions(...args)
  const queryFn = options.queryFn as (context: { signal: AbortSignal }) => Promise<TotalsPoint[]>
  return queryFn(queryContext())
}

describe('seriesPartRounds', () => {
  it('reads 16 coarse rounds, both ends included, every 8th of the full grid', () => {
    const coarse = seriesPartRounds(WINDOW, 'coarse')
    const fill = seriesPartRounds(WINDOW, 'fill')
    expect(coarse).toHaveLength(16)
    expect(coarse[0]).toBe(WINDOW.start)
    expect(coarse[15]).toBe(WINDOW.end)
    expect(fill).toHaveLength(105)

    const grid = [...coarse, ...fill].sort((a, b) => (a < b ? -1 : 1))
    expect(new Set(grid).size).toBe(121)
    grid.forEach((round, i) => {
      expect(coarse.includes(round)).toBe(i % 8 === 0)
    })
  })

  it('never reads a round twice when the window is narrower than the grid', () => {
    const narrow = { start: 100n, end: 140n }
    const coarse = seriesPartRounds(narrow, 'coarse')
    const fill = seriesPartRounds(narrow, 'fill')
    expect(fill.some((round) => coarse.includes(round))).toBe(false)
    expect(new Set([...coarse, ...fill]).size).toBe(41)
  })
})

describe('totalsSeriesPartQueryOptions', () => {
  it('reads the registry in one series call per pass, with block times', async () => {
    mockSdk.getRegistryTotalsSeries.mockClear()
    mockSdk.getRegistryTotals.mockClear()

    const points = await fetchPart({ registry: true }, WINDOW, 'coarse')

    expect(mockSdk.getRegistryTotalsSeries).toHaveBeenCalledTimes(1)
    expect(mockSdk.getRegistryTotalsSeries).toHaveBeenCalledWith(
      seriesPartRounds(WINDOW, 'coarse'),
      { signal: expect.any(AbortSignal) },
    )
    expect(mockSdk.getRegistryTotals).not.toHaveBeenCalled()
    expect(points).toHaveLength(16)
    expect(points[0]).toEqual({
      round: WINDOW.start,
      timestamp: mockTimestampAt(WINDOW.start),
      staked: 1,
      stakers: Number(WINDOW.start % 100n),
      validators: 1,
    })
    // The block times seed the date → round cache
    expect(roundTimes.get(WINDOW.end)).toBe(mockTimestampAt(WINDOW.end))
  })

  it('leaves out rounds that fail to read', async () => {
    mockSdk.getRegistryTotalsSeries.mockImplementationOnce(async (rounds) =>
      rounds.map((round, i) =>
        i === 0
          ? { round: BigInt(round), ok: false as const, error: new Error('nope') }
          : {
              round: BigInt(round),
              ok: true as const,
              value: { numValidators: 1, numStakers: 1n, staked: 0n },
              timestamp: mockTimestampAt(BigInt(round)),
            },
      ),
    )
    const points = await fetchPart({ registry: true }, WINDOW, 'fill')
    expect(points).toHaveLength(104)
  })

  it("reads a validator's totals", async () => {
    mockSdk.getValidatorTotalsSeries.mockClear()
    const points = await fetchPart({ validator: 7 }, WINDOW, 'fill')
    expect(mockSdk.getValidatorTotalsSeries).toHaveBeenCalledWith(
      [7],
      seriesPartRounds(WINDOW, 'fill'),
      { signal: expect.any(AbortSignal) },
    )
    expect(points[0]).toMatchObject({ staked: 5, stakers: 2 })
    expect(points[0].validators).toBeUndefined()
  })

  it('reads nothing for an empty window', async () => {
    mockSdk.getRegistryTotalsSeries.mockClear()
    expect(await fetchPart({ registry: true }, null, 'coarse')).toEqual([])
    expect(mockSdk.getRegistryTotalsSeries).not.toHaveBeenCalled()
  })
})

const DAY = 86_400
const NOW = 1_760_000_000

/** A history `days` long, ending now. */
const extentOf = (days: number): SeriesExtent => ({
  start: 40_000_000n,
  startTime: NOW - days * DAY,
  end: 53_000_000n,
  endTime: NOW,
})

describe('rangeApplies', () => {
  it('offers 1M and All, but not ranges longer than a 2 month history', () => {
    const extent = extentOf(60)
    expect(rangeApplies('1m', extent)).toBe(true)
    expect(rangeApplies('3m', extent)).toBe(false)
    expect(rangeApplies('1y', extent)).toBe(false)
    expect(rangeApplies('all', extent)).toBe(true)
  })

  it('offers every range over a longer history', () => {
    const extent = extentOf(400)
    expect(rangeApplies('3m', extent)).toBe(true)
    expect(rangeApplies('1y', extent)).toBe(true)
  })

  it('always offers 1M, even over a shorter history', () => {
    expect(rangeApplies('1m', extentOf(10))).toBe(true)
  })
})

describe('seriesWindowQueryOptions', () => {
  const fetchWindow = (extent: SeriesExtent | null) => {
    const options = seriesWindowQueryOptions({ registry: true }, 'all', extent)
    return (options.queryFn as (context: { signal: AbortSignal }) => Promise<unknown>)(
      queryContext(),
    )
  }

  it('spans the whole extent for All', async () => {
    expect(await fetchWindow(extentOf(60))).toEqual({ start: 40_000_000n, end: 53_000_000n })
  })

  it('has nothing to draw without an extent', async () => {
    expect(await fetchWindow(null)).toBeNull()
  })

  it('waits for the extent', () => {
    expect(seriesWindowQueryOptions({ registry: true }, '1m', undefined).enabled).toBe(false)
  })
})

describe('seriesExtentQueryOptions', () => {
  it('reads nothing once its signal has aborted', async () => {
    mockSdk.getChangeRounds.mockClear()
    const controller = new AbortController()
    controller.abort()
    const options = seriesExtentQueryOptions({ validator: 7 })
    const queryFn = options.queryFn as (context: { signal: AbortSignal }) => Promise<unknown>

    await expect(queryFn(queryContext(controller.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(mockSdk.getChangeRounds).not.toHaveBeenCalled()
  })
})

describe('mergeSeries', () => {
  const point = (round: number): TotalsPoint => ({
    round: BigInt(round),
    timestamp: round,
    staked: round,
    stakers: round,
  })

  it('interleaves two ascending series, keeping one of each round', () => {
    const merged = mergeSeries([point(1), point(5), point(9)], [point(2), point(5), point(10)])
    expect(merged.map((p) => Number(p.round))).toEqual([1, 2, 5, 9, 10])
  })

  it('handles an empty side', () => {
    expect(mergeSeries([], [point(3)])).toEqual([point(3)])
    expect(mergeSeries([point(3)], [])).toEqual([point(3)])
  })
})

const STAKER = 'STAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERSTAKERST'

const POOL = {
  validatorId: 7n,
  poolId: 1n,
  poolAppId: 1010n,
  joinRound: 100n,
  joinTimestamp: 1_700_000_000,
}

const JOIN: StakeEvent = {
  round: 100n,
  timestamp: 1_700_000_000,
  validatorId: 7n,
  poolId: 1n,
  poolAppId: 1010n,
  kind: 'deposit',
  amount: 5_000_000n,
  balanceAfter: 5_000_000n,
  joined: true,
}

const TOP_UP: StakeEvent = {
  ...JOIN,
  round: 200n,
  timestamp: 1_700_000_280,
  amount: 1_000_000n,
  balanceAfter: 6_000_000n,
  joined: undefined,
}

const HISTORY: StakerHistory = { events: [TOP_UP, JOIN], pools: [POOL], round: 300n }

describe('stakerHistoryQueryOptions', () => {
  it('keys on the address, the validator and the round, the round last', () => {
    const queryClient = new QueryClient()
    expect(stakerHistoryQueryOptions(queryClient, STAKER).queryKey).toEqual([
      'staker-history',
      STAKER,
      'all',
      'latest',
    ])
    expect(stakerHistoryQueryOptions(queryClient, STAKER, 123n, 7).queryKey).toEqual([
      'staker-history',
      STAKER,
      '7',
      'round:123',
    ])
    expect(stakerPoolsQueryOptions(STAKER, 123n).queryKey).toEqual([
      'staker-pools',
      STAKER,
      'round:123',
    ])
  })

  it('never refetches a pinned history, and drops it like other pinned reads', () => {
    const queryClient = new QueryClient()
    const pinned = stakerHistoryQueryOptions(queryClient, STAKER, 123n)
    expect(pinned.staleTime).toBe(Infinity)
    expect(pinned.gcTime).toBe(PINNED_GC_TIME)
    expect(pinned.refetchOnWindowFocus).toBe(false)
    const live = stakerHistoryQueryOptions(queryClient, STAKER)
    expect(live.staleTime).toBe(1000 * 60 * 5)
    expect(live.gcTime).toBeUndefined()
  })

  it('is disabled without an address', () => {
    expect(stakerHistoryQueryOptions(new QueryClient(), '').enabled).toBe(false)
  })

  it('reads up to the pinned round with the query signal, and live without one', async () => {
    const queryClient = new QueryClient()
    mockSdk.getStakerHistory.mockClear()

    await queryClient.fetchQuery(stakerHistoryQueryOptions(queryClient, STAKER, 123n, 7))
    expect(mockSdk.getStakerHistory).toHaveBeenLastCalledWith(STAKER, {
      maxRound: 123n,
      validatorId: 7,
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    })

    await queryClient.fetchQuery(stakerHistoryQueryOptions(queryClient, STAKER))
    expect(mockSdk.getStakerHistory.mock.lastCall?.[1]?.signal).toBeUndefined()
    expect(mockSdk.getStakerHistory.mock.lastCall?.[1]?.maxRound).toBeUndefined()
  })

  it('fills the cache in as the history loads, then marks it complete', async () => {
    const queryClient = new QueryClient()
    const options = stakerHistoryQueryOptions(queryClient, STAKER)
    const seen: (StakerHistoryData | undefined)[] = []
    mockSdk.getStakerHistory.mockImplementationOnce(
      async (_staker: string, opts?: StakerHistoryOptions) => {
        const progress = { pools: 1, poolsListed: 1, poolsDone: 0, waves: 1, reads: 2 }
        opts?.onProgress?.({ ...progress, partial: { ...HISTORY, events: [JOIN] } })
        seen.push(queryClient.getQueryData<StakerHistoryData>(options.queryKey))
        return HISTORY
      },
    )

    const history = await queryClient.fetchQuery(options)

    expect(seen[0]).toMatchObject({
      events: [JOIN],
      pools: [POOL],
      complete: false,
      progress: { pools: 1, poolsDone: 0, waves: 1 },
    })
    expect(history).toEqual({ ...HISTORY, complete: true })
    // The full history's pools stand in for the pools read
    expect(queryClient.getQueryData(stakerPoolsQueryKey(STAKER))).toEqual([POOL])
    // Its rounds' times are kept
    expect(roundTimes.get(200n)).toBe(1_700_000_280)
  })

  it('keeps a complete history on screen while it refetches', async () => {
    const queryClient = new QueryClient()
    const key = stakerHistoryQueryKey(STAKER)
    const complete: StakerHistoryData = { ...HISTORY, complete: true }
    queryClient.setQueryData(key, complete)
    let seen: StakerHistoryData | undefined
    mockSdk.getStakerHistory.mockImplementationOnce(
      async (_staker: string, opts?: StakerHistoryOptions) => {
        const progress = { pools: 1, poolsListed: 1, poolsDone: 0, waves: 1, reads: 2 }
        opts?.onProgress?.({ ...progress, partial: { ...HISTORY, events: [] } })
        seen = queryClient.getQueryData<StakerHistoryData>(key)
        return HISTORY
      },
    )

    await queryClient.fetchQuery({
      ...stakerHistoryQueryOptions(queryClient, STAKER),
      staleTime: 0,
    })

    expect(seen).toBe(complete)
  })

  it("doesn't seed the pools from one validator's history", async () => {
    const queryClient = new QueryClient()
    await queryClient.fetchQuery(stakerHistoryQueryOptions(queryClient, STAKER, undefined, 7))
    expect(queryClient.getQueryData(stakerPoolsQueryKey(STAKER))).toBeUndefined()
  })
})

describe('changeDescriptionsQueryOptions', () => {
  const VALIDATOR = 1
  const POOLS = [1010n, 1020n]
  const change = (round: bigint, deleted = false) => ({ round, timestamp: 0, deleted })
  const { reader } = mockSdk.ghost

  /** The next batched read fails at `failing` rounds, as a node that drops a request would. */
  const failNextReadAt = (failing: bigint[]) => {
    const real = mockSdk.ghost.atRounds.getMockImplementation()!
    mockSdk.ghost.atRounds.mockImplementationOnce(async (rounds, fn, options) =>
      (await real(rounds, fn, options)).map((result) =>
        failing.includes(result.round)
          ? { round: result.round, ok: false as const, error: new Error('dropped') }
          : result,
      ),
    )
  }

  beforeEach(() => {
    mockSdk.ghost.atRounds.mockClear()
    reader.getValidatorTotals.mockReset()
    reader.getPoolStates.mockReset()
    // Pool 1020 takes 5,000 ALGO and a staker at round 200; the validator with it
    reader.getValidatorTotals.mockImplementation(async ({ methodArgsOrArgsArray }, round) =>
      methodArgsOrArgsArray.validatorIds.map((id) =>
        round >= 200n
          ? mockValidatorTotals(id, {
              numPools: 2n,
              totalStakers: 3n,
              totalAlgoStaked: 5_002_000_000n,
            })
          : mockValidatorTotals(id, {
              numPools: 2n,
              totalStakers: 2n,
              totalAlgoStaked: 2_000_000n,
            }),
      ),
    )
    reader.getPoolStates.mockImplementation(async ({ methodArgsOrArgsArray }, round) =>
      methodArgsOrArgsArray.pools.map((id) =>
        id === 1020n && round >= 200n
          ? mockPoolState(id, { numStakers: 3n, staked: 5_001_000_000n })
          : mockPoolState(id),
      ),
    )
  })

  it('reads both rounds of every row in one batched read, and leaves deleted rows to the list', async () => {
    const queryClient = new QueryClient()
    const changes = [change(300n, true), change(200n), change(100n)]
    const descriptions = await queryClient.fetchQuery(
      changeDescriptionsQueryOptions(queryClient, VALIDATOR, POOLS, changes),
    )
    expect(mockSdk.ghost.atRounds).toHaveBeenCalledTimes(1)
    expect(mockSdk.ghost.atRounds.mock.calls[0][0]).toEqual([99n, 100n, 199n, 200n])
    expect(reader.getPoolStates).toHaveBeenCalledWith(
      { methodArgsOrArgsArray: { pools: POOLS } },
      200n,
    )
    expect(descriptions).toEqual({
      '200': 'Pool 2 · +5,000 ALGO · +1 staker',
      '100': 'Settings changed',
    })
  })

  it('reads a round that failed once more', async () => {
    failNextReadAt([199n])
    const queryClient = new QueryClient()
    const descriptions = await queryClient.fetchQuery(
      changeDescriptionsQueryOptions(queryClient, VALIDATOR, POOLS, [change(200n), change(100n)]),
    )
    expect(mockSdk.ghost.atRounds).toHaveBeenCalledTimes(2)
    expect(mockSdk.ghost.atRounds.mock.calls[1][0]).toEqual([199n])
    expect(descriptions).toEqual({
      '200': 'Pool 2 · +5,000 ALGO · +1 staker',
      '100': 'Settings changed',
    })
  })

  it('leaves out a row that failed twice, and reads it again next time, alone', async () => {
    failNextReadAt([199n])
    failNextReadAt([199n])
    const queryClient = new QueryClient()
    const options = changeDescriptionsQueryOptions(queryClient, VALIDATOR, POOLS, [
      change(200n),
      change(100n),
    ])
    expect(await queryClient.fetchQuery(options)).toEqual({ '100': 'Settings changed' })

    // Incomplete, so not final: the next fetch reads the missing row's rounds only
    expect(await queryClient.fetchQuery(options)).toEqual({
      '200': 'Pool 2 · +5,000 ALGO · +1 staker',
      '100': 'Settings changed',
    })
    expect(mockSdk.ghost.atRounds).toHaveBeenCalledTimes(3)
    expect(mockSdk.ghost.atRounds.mock.calls[2][0]).toEqual([199n, 200n])

    // Complete: final
    await queryClient.fetchQuery(options)
    expect(mockSdk.ghost.atRounds).toHaveBeenCalledTimes(3)
  })

  it('leaves out a row with more pools than the list read with, until the pools catch up', async () => {
    // Pool 1030 is added at round 200
    reader.getValidatorTotals.mockImplementation(async ({ methodArgsOrArgsArray }, round) =>
      methodArgsOrArgsArray.validatorIds.map((id) =>
        mockValidatorTotals(id, { numPools: round >= 200n ? 3n : 2n }),
      ),
    )
    reader.getPoolStates.mockImplementation(async ({ methodArgsOrArgsArray }, round) =>
      methodArgsOrArgsArray.pools.map((id) =>
        mockPoolState(id, id === 1030n && round < 200n ? { exists: false } : {}),
      ),
    )
    const queryClient = new QueryClient()
    const changes = [change(200n), change(100n)]

    // The previous round's two pools: no guess at round 200
    const stale = await queryClient.fetchQuery(
      changeDescriptionsQueryOptions(queryClient, VALIDATOR, POOLS, changes),
    )
    expect(stale).toEqual({ '100': 'Settings changed' })

    const fresh = await queryClient.fetchQuery(
      changeDescriptionsQueryOptions(queryClient, VALIDATOR, [...POOLS, 1030n], changes),
    )
    expect(fresh).toEqual({ '200': 'Pool 3 added', '100': 'Settings changed' })
  })

  it('reads only the rows no other page has described, and nothing when all are', async () => {
    const queryClient = new QueryClient()
    await queryClient.fetchQuery(
      changeDescriptionsQueryOptions(queryClient, VALIDATOR, POOLS, [change(200n), change(100n)]),
    )
    // The list at another round: one new row, one already described
    const overlapping = changeDescriptionsQueryOptions(queryClient, VALIDATOR, POOLS, [
      change(250n),
      change(200n),
    ])
    expect((overlapping.placeholderData as unknown as () => Record<string, string>)()).toEqual({
      '200': 'Pool 2 · +5,000 ALGO · +1 staker',
    })
    const descriptions = await queryClient.fetchQuery(overlapping)
    expect(mockSdk.ghost.atRounds).toHaveBeenCalledTimes(2)
    expect(mockSdk.ghost.atRounds.mock.calls[1][0]).toEqual([249n, 250n])
    expect(descriptions).toEqual({
      '250': 'Settings changed',
      '200': 'Pool 2 · +5,000 ALGO · +1 staker',
    })

    // Every row known: no read at all
    await queryClient.fetchQuery(
      changeDescriptionsQueryOptions(queryClient, VALIDATOR, POOLS, [change(250n), change(100n)]),
    )
    expect(mockSdk.ghost.atRounds).toHaveBeenCalledTimes(2)
  })
})

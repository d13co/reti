import { describe, expect, it, vi } from 'vitest'
import {
  mergeSeries,
  rangeApplies,
  type SeriesExtent,
  seriesExtentQueryOptions,
  seriesPartRounds,
  seriesWindowQueryOptions,
  totalsSeriesPartQueryOptions,
  type TotalsPoint,
} from '@/api/history'
import { roundTimes } from '@/api/roundTimes'
import { mockSdk, mockTimestampAt } from '@/utils/tests/sdk'

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

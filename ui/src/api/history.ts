import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import {
  seriesRounds,
  type TimelineOptions,
  type TimelinePage,
  type TimelineTarget,
} from 'reti-ghost-sdk'
import { readAlgorand, registryCreation, retiSdk, timeReader } from '@/api/reti'
import { roundAtTime, roundTimes, timestampOf } from '@/api/roundTimes'
import { Trace, traceQuery } from '@/api/trace'
import { untilAborted } from '@/utils/abort'
import { dayjs } from '@/utils/dayjs'

/**
 * History reads: the rounds at which something changed, and the chain's latest round. These need
 * a dtalgorand node (its `/versions` endpoints), so callers gate them on
 * `timeTravelSupportQueryOptions`.
 */

export type { TimelineTarget } from 'reti-ghost-sdk'

/** A stable, serialisable key for a timeline target. */
export function timelineTargetKey(target: TimelineTarget): string {
  if ('validator' in target) return `validator:${target.validator}`
  if ('registry' in target) return 'registry'
  if ('pool' in target) return `pool:${target.pool}`
  if ('poolStakers' in target) return `pool-stakers:${target.poolStakers}`
  return `staker:${target.staker}`
}

/** A page of changes, logged with the bounds it was asked for; its rounds' times are kept. */
function tracedChanges(
  trace: Trace,
  target: TimelineTarget,
  options: TimelineOptions,
): Promise<TimelinePage> {
  return trace.step(
    'changes',
    {
      target: timelineTargetKey(target),
      minRound: options.minRound,
      maxRound: options.maxRound,
      order: options.order,
      limit: options.limit,
      page: options.next,
    },
    async () => {
      const page = await roundTimes.track(
        retiSdk.getChangeRounds(target, { ...options, signal: trace.signal }),
      )
      roundTimes.addAll(page.changes)
      return page
    },
    (page) => {
      const rounds = page.changes.map((change) => change.round)
      return rounds.length === 0
        ? 'none'
        : `${rounds.length} (${rounds[0]}…${rounds[rounds.length - 1]})${page.next ? ', more' : ''}`
    },
  )
}

/** The read node's latest round, logged. */
function tracedLatestRound(trace: Trace): Promise<bigint> {
  return trace.step(
    'status',
    {},
    async () =>
      (
        await readAlgorand.client.algod
          .status()
          .do(undefined, trace.signal && { signal: trace.signal })
      ).lastRound,
    (round) => `latest=${round}`,
  )
}

/**
 * One page of the rounds at which `target` changed, newest first by default. Rounds only: the UI
 * reads the state at a chosen round through the normal `?round=` reads. A page bounded by a
 * `maxRound` in the past never changes.
 */
export const changeRoundsQueryOptions = (target: TimelineTarget, options: TimelineOptions = {}) =>
  queryOptions<TimelinePage>({
    queryKey: [
      'change-rounds',
      timelineTargetKey(target),
      {
        minRound: options.minRound?.toString(),
        maxRound: options.maxRound?.toString(),
        limit: options.limit,
        order: options.order,
        next: options.next,
      },
    ],
    queryFn: async ({ signal }) => {
      const trace = traceQuery(`change-rounds ${timelineTargetKey(target)}`, signal)
      const page = await tracedChanges(trace, target, options)
      trace.done()
      return page
    },
    staleTime: options.maxRound !== undefined ? Infinity : 1000 * 60,
  })

export interface AdjacentChanges {
  /** The change before the one that produced the state at the round, if any. */
  previous?: bigint
  /** The first change after the round, if any. */
  next?: bigint
}

/**
 * The changes to step to from `round`. The state at `round` is the result of the last change at
 * or before it, so "previous" is the change before that one, and "next" the first one after.
 */
export const adjacentChangesQueryOptions = (target: TimelineTarget, round: bigint) =>
  queryOptions<AdjacentChanges>({
    queryKey: ['adjacent-changes', timelineTargetKey(target), round.toString()],
    queryFn: async ({ signal }) => {
      const trace = traceQuery(`adjacent-changes ${timelineTargetKey(target)} @${round}`, signal)
      const [before, after] = await Promise.all([
        tracedChanges(trace, target, { maxRound: round, order: 'desc', limit: 2 }),
        tracedChanges(trace, target, { minRound: round + 1n, order: 'asc', limit: 1 }),
      ])
      const adjacent = { previous: before.changes[1]?.round, next: after.changes[0]?.round }
      trace.done(`previous=${adjacent.previous ?? 'none'}, next=${adjacent.next ?? 'none'}`)
      return adjacent
    },
    // "Next" can appear as the chain moves on; "previous" never changes
    staleTime: 1000 * 60,
  })

/** Changes per page of a timeline list. */
const TIMELINE_PAGE_SIZE = 50

/**
 * The rounds at which `target` changed, newest first, up to `maxRound` (the latest when
 * undefined), a page at a time.
 */
export const changeRoundsInfiniteQueryOptions = (target: TimelineTarget, maxRound?: bigint) =>
  infiniteQueryOptions({
    queryKey: ['change-rounds-pages', timelineTargetKey(target), maxRound?.toString() ?? 'latest'],
    queryFn: async ({ pageParam, signal }) => {
      const trace = traceQuery(`changes-list ${timelineTargetKey(target)}`, signal)
      const page = await tracedChanges(trace, target, {
        maxRound,
        order: 'desc',
        limit: TIMELINE_PAGE_SIZE,
        next: pageParam,
      })
      trace.done()
      return page
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next,
    staleTime: maxRound !== undefined ? Infinity : 1000 * 60,
  })

/** How far back a history chart reaches from the round it ends at. */
export type HistoryRange = '1m' | '3m' | '1y' | 'all'

export const HISTORY_RANGES: { value: HistoryRange; label: string }[] = [
  { value: '1m', label: '1M' },
  { value: '3m', label: '3M' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' },
]

const RANGE_START: Record<Exclude<HistoryRange, 'all'>, [number, dayjs.ManipulateType]> = {
  '1m': [1, 'month'],
  '3m': [3, 'month'],
  '1y': [1, 'year'],
}

/**
 * A live chart ends at the latest round rounded down to this, so refetching it soon after ends at
 * the same round, whose block time is already known.
 */
const LIVE_END_GRANULARITY = 1000n

const floorRound = (round: bigint) => round - (round % LIVE_END_GRANULARITY)

export interface TotalsPoint {
  round: bigint
  /** The round's block time, in seconds */
  timestamp: number
  /** ALGO */
  staked: number
  stakers: number
  /** Registry series only */
  validators?: number
}

/** A history chart's subject: the registry as a whole, or one validator. */
export type TotalsTarget = { registry: true } | { validator: number }

/** The rounds a history chart spans, both included. Empty when there is nothing to draw. */
export interface SeriesWindow {
  start: bigint
  end: bigint
}

/**
 * All of a target's history up to `to` (the latest when undefined): from the registry's creation
 * or, for a validator, the round it was added, with both ends' block times. Every range's window
 * is cut from it, and it says which ranges are longer than the history.
 */
export interface SeriesExtent {
  start: bigint
  /** Seconds */
  startTime: number
  end: bigint
  /** Seconds */
  endTime: number
}

export const seriesExtentQueryOptions = (target: TotalsTarget, to?: bigint) =>
  queryOptions({
    queryKey: ['totals-series', timelineTargetKey(target), 'extent', to?.toString() ?? 'latest'],
    queryFn: async ({ signal }): Promise<SeriesExtent | null> => {
      const trace = traceQuery(`totals-series ${timelineTargetKey(target)} extent`, signal)
      const extent = await loadSeriesExtent(trace, target, to)
      trace.done(extent ? `${extent.start}…${extent.end}` : 'empty')
      return extent
    },
    staleTime: to !== undefined ? Infinity : 1000 * 60 * 10,
  })

async function loadSeriesExtent(
  trace: Trace,
  target: TotalsTarget,
  to?: bigint,
): Promise<SeriesExtent | null> {
  // Independent reads, all at once: the registry's creation, the end and its time, and (for a
  // validator) when it was added. Its first version is the same from round 1 as from creation.
  const [creation, { end, endTime }, first] = await Promise.all([
    // Shared by the whole page, so only the wait is cancelled
    untilAborted(registryCreation(), trace.signal),
    (async () => {
      const end = to ?? floorRound(await tracedLatestRound(trace))
      return { end, endTime: await timestampOf(trace, retiSdk, end, 'latest') }
    })(),
    'validator' in target
      ? tracedChanges(
          trace,
          { validator: target.validator },
          { minRound: 1n, order: 'asc', limit: 1 },
        )
      : undefined,
  ])
  let start = creation?.round ?? 1n
  let startTime = creation?.timestamp

  // Nothing to draw before the validator was added
  const added = first?.changes[0]
  if (added && added.round > start) {
    start = added.round
    startTime = added.timestamp
  }
  if (start >= end) return null
  startTime ??= await timestampOf(trace, retiSdk, start, 'earliest')
  return { start, startTime, end, endTime }
}

/**
 * Whether `range` shows something its neighbours don't: false when the history is shorter, as
 * the chart would then be All's. 1M and All always apply.
 */
export function rangeApplies(range: HistoryRange, extent: SeriesExtent): boolean {
  if (range === '1m' || range === 'all') return true
  const [amount, unit] = RANGE_START[range]
  return extent.startTime < dayjs.unix(extent.endTime).subtract(amount, unit).unix()
}

/** The rounds a chart spans: `range` back from the extent's end, and no earlier than its start. */
export const seriesWindowQueryOptions = (
  target: TotalsTarget,
  range: HistoryRange,
  extent: SeriesExtent | null | undefined,
) =>
  queryOptions({
    queryKey: [
      'totals-series',
      timelineTargetKey(target),
      range,
      extent?.start.toString(),
      extent?.end.toString(),
      'window',
    ],
    queryFn: async ({ signal }): Promise<SeriesWindow | null> => {
      if (!extent) return null
      const trace = traceQuery(`totals-series ${timelineTargetKey(target)} ${range} window`, signal)
      const window = await loadSeriesWindow(trace, range, extent)
      trace.done(window ? `${window.start}…${window.end}` : 'empty')
      return window
    },
    enabled: extent !== undefined,
    // The extent pins both ends, so the window never changes
    staleTime: Infinity,
  })

async function loadSeriesWindow(
  trace: Trace,
  range: HistoryRange,
  { start: first, end, endTime }: SeriesExtent,
): Promise<SeriesWindow | null> {
  let start = first
  if (range !== 'all') {
    const [amount, unit] = RANGE_START[range]
    const startTime = dayjs.unix(endTime).subtract(amount, unit).toDate()
    // Within half a point of the chart's grid is as good as exact
    const pointSeconds = (endTime - startTime.getTime() / 1000) / (SERIES_POINTS - 1)
    const rangeStart = (
      await roundAtTime(trace, timeReader, startTime, { tolerance: pointSeconds / 2 })
    ).round
    if (rangeStart > start) start = rangeStart
  }
  if (start >= end) return null
  return { start, end }
}

/**
 * Which rounds of a chart to read. A chart loads in two passes: `coarse` is a few rounds spread
 * over the window, enough to draw its shape fast; `fill` is the rest of the full grid. Over any
 * window wider than the grid, coarse's rounds are exactly every 8th grid round.
 */
export type SeriesPart = 'coarse' | 'fill'

/** Rounds in the coarse pass. */
const COARSE_POINTS = 16

/**
 * Rounds in a full chart: 15 coarse intervals of 8 points each, within the 64-128 the SDK suggests
 * for a node that simulates (a node with queries would take more).
 */
const SERIES_POINTS = (COARSE_POINTS - 1) * 8 + 1

/** The rounds a pass reads, ascending. */
export function seriesPartRounds({ start, end }: SeriesWindow, part: SeriesPart): bigint[] {
  const coarse = seriesRounds({ from: start, to: end, points: COARSE_POINTS })
  if (part === 'coarse') return coarse
  const read = new Set(coarse)
  return seriesRounds({ from: start, to: end, points: SERIES_POINTS }).filter(
    (round) => !read.has(round),
  )
}

/**
 * Stake and stakers at one pass's rounds over `window`, each with its block time, in one
 * batched read. Rounds that fail to read are left out. A window in the past never changes, and nor
 * does a live one, as its end is a past round.
 */
export const totalsSeriesPartQueryOptions = (
  target: TotalsTarget,
  window: SeriesWindow | null | undefined,
  part: SeriesPart,
) =>
  queryOptions({
    queryKey: [
      'totals-series',
      timelineTargetKey(target),
      window?.start.toString(),
      window?.end.toString(),
      part,
    ],
    queryFn: async ({ signal }): Promise<TotalsPoint[]> => {
      if (!window) return []
      const trace = traceQuery(`totals-series ${timelineTargetKey(target)} ${part}`, signal)
      const points = await readTotals(trace, target, seriesPartRounds(window, part))
      roundTimes.addAll(points)
      trace.done(`points=${points.length}`)
      return points
    },
    enabled: !!window,
    staleTime: Infinity,
  })

/** The totals at `rounds`, in one batched read; rounds that fail to read are left out. */
async function readTotals(
  trace: Trace,
  target: TotalsTarget,
  rounds: bigint[],
): Promise<TotalsPoint[]> {
  if (rounds.length === 0) return []
  const params = {
    sim: 1,
    rounds: rounds.length,
    from: rounds[0],
    to: rounds[rounds.length - 1],
  }
  const summary = (series: { ok: boolean }[]) =>
    `${series.filter((point) => point.ok).length}/${series.length} ok`

  if ('validator' in target) {
    const series = await trace.step(
      'validator-totals',
      { ...params, validator: target.validator },
      () => retiSdk.getValidatorTotalsSeries([target.validator], rounds, { signal: trace.signal }),
      summary,
    )
    return series.flatMap((point) =>
      point.ok && point.value[0]
        ? [
            {
              round: point.round,
              timestamp: point.timestamp,
              staked: Number(point.value[0].totalAlgoStaked) / 1e6,
              stakers: Number(point.value[0].totalStakers),
            },
          ]
        : [],
    )
  }

  const series = await trace.step(
    'registry-totals',
    params,
    () => retiSdk.getRegistryTotalsSeries(rounds, { signal: trace.signal }),
    summary,
  )
  return series.flatMap((point) =>
    point.ok
      ? [
          {
            round: point.round,
            timestamp: point.timestamp,
            staked: Number(point.value.staked) / 1e6,
            stakers: Number(point.value.numStakers),
            validators: point.value.numValidators,
          },
        ]
      : [],
  )
}

/** Two ascending series of points merged into one, ascending. */
export function mergeSeries(a: TotalsPoint[], b: TotalsPoint[]): TotalsPoint[] {
  const merged: TotalsPoint[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i].round <= b[j].round)) {
      if (j < b.length && a[i].round === b[j].round) j += 1
      merged.push(a[i++])
    } else {
      merged.push(b[j++])
    }
  }
  return merged
}

/** The read node's latest round. */
export const latestRoundQueryOptions = queryOptions({
  queryKey: ['latest-round'],
  queryFn: async () => {
    const trace = traceQuery('latest-round')
    const round = await tracedLatestRound(trace)
    trace.done()
    return round
  },
  staleTime: 1000 * 10,
})

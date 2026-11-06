import { useQuery } from '@tanstack/react-query'
import { AreaChart, CustomTooltipProps } from '@tremor/react'
import * as React from 'react'
import {
  HISTORY_RANGES,
  HistoryRange,
  mergeSeries,
  rangeApplies,
  SeriesExtent,
  seriesExtentQueryOptions,
  seriesWindowQueryOptions,
  timelineTargetKey,
  TotalsTarget,
  totalsSeriesPartQueryOptions,
} from '@/api/history'
import { timeTravelSupportQueryOptions } from '@/api/reti'
import { Loading } from '@/components/Loading'
import { ReadFailure } from '@/components/ReadFailure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton, SkeletonText } from '@/components/ui/skeleton'
import { useAtRound } from '@/hooks/useAtRound'
import { useOwnStakesFirst } from '@/hooks/useOwnStakesFirst'
import { useSetRound } from '@/hooks/useSetRound'
import { dayjs } from '@/utils/dayjs'
import { formatAmount, formatSampleInterval } from '@/utils/format'
import { cn } from '@/utils/ui'

interface TotalsHistoryProps {
  /** The registry as a whole, or one validator */
  target: TotalsTarget
  title: string
  className?: string
  /** One chart per row on large screens, where the card sits in a narrow column */
  stacked?: boolean
}

type Metric = 'staked' | 'stakers' | 'validators'

interface MetricSpec {
  key: Metric
  label: string
  format: (value: number) => string
}

interface ChartPoint extends Record<Metric, number> {
  date: string
  round: string
}

const METRICS: MetricSpec[] = [
  {
    key: 'staked',
    label: 'Total staked (ALGO)',
    format: (v) => formatAmount(v, { compact: true, precision: 1 }),
  },
  { key: 'stakers', label: 'Stakers', format: (v) => formatAmount(v, { precision: 0 }) },
  { key: 'validators', label: 'Validators', format: (v) => formatAmount(v, { precision: 0 }) },
]

interface MetricChartProps {
  data: ChartPoint[]
  metric: MetricSpec
  onPick: (round: bigint) => void
}

/**
 * The point a click or tap on the chart lands nearest to, or undefined off the plot (over the axes).
 * Read from where it lands rather than from the tooltip, which a tap may not have shown yet.
 */
function pointAt<T>(chart: HTMLElement, clientX: number, clientY: number, data: T[]) {
  // The plot, and the area's ends: the first and last points, evenly spaced between
  const plot = chart.querySelector('.recharts-cartesian-grid')?.getBoundingClientRect()
  const area = chart.querySelector('.recharts-area-area')?.getBoundingClientRect()
  if (!plot || !area || data.length === 0) return undefined
  if (clientX < plot.left || clientX > plot.right || clientY < plot.top || clientY > plot.bottom) {
    return undefined
  }
  const step = data.length > 1 ? area.width / (data.length - 1) : 1
  const index = Math.round((clientX - area.left) / step)
  return data[Math.min(Math.max(index, 0), data.length - 1)]
}

/**
 * One measure over time. Clicking or tapping anywhere on the plot, its dot included, picks the
 * point nearest to it (the one its tooltip shows).
 */
function MetricChart({ data, metric, onPick }: MetricChartProps) {
  const Tooltip = React.useCallback(
    ({ payload, active }: CustomTooltipProps) => {
      const point = payload?.[0]?.payload as ChartPoint | undefined
      if (!active || !point) return null
      return (
        <div className="rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
          <p className="font-semibold tabular-nums">{metric.format(point[metric.key])}</p>
          <p className="text-xs text-muted-foreground">
            {point.date} · round {BigInt(point.round).toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground">Click to view</p>
        </div>
      )
    },
    [metric],
  )

  return (
    <div>
      <p className="text-sm font-medium text-muted-foreground">{metric.label}</p>
      <p className="text-xl font-semibold tabular-nums">
        {metric.format(data[data.length - 1][metric.key])}
      </p>
      <div
        className="cursor-pointer"
        // Capture: Tremor's dot under the cursor stops its clicks from bubbling
        onClickCapture={(event) => {
          const point = pointAt(event.currentTarget, event.clientX, event.clientY, data)
          if (point) onPick(BigInt(point.round))
        }}
      >
        <AreaChart
          className="mt-2 h-40"
          data={data}
          index="date"
          categories={[metric.key]}
          colors={['primary-600']}
          valueFormatter={metric.format}
          customTooltip={Tooltip}
          showLegend={false}
          showGradient
          yAxisWidth={48}
          startEndOnly
          // An area's height is its value, so the axis starts at zero
          minValue={0}
          connectNulls
        />
      </div>
    </div>
  )
}

/**
 * Keeps the previous chart on screen while another range or round loads, but only for the same
 * registry or validator: another validator's chart would be the wrong one.
 */
const keepSameTarget =
  (target: TotalsTarget) =>
  <T,>(previousData: T | undefined, previousQuery?: { queryKey: readonly unknown[] }) =>
    previousQuery?.queryKey[1] === timelineTargetKey(target) ? previousData : undefined

const metricsFor = (target: TotalsTarget) =>
  METRICS.filter((metric) => metric.key !== 'validators' || 'registry' in target)

// Stacked: side by side while the card is full width, one per row in the large screens' narrow column
const CHARTS_GRID = (count: number, stacked?: boolean) =>
  cn('grid gap-6', count === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2', stacked && 'lg:grid-cols-1')

interface HistoryHeaderProps {
  title: string
  range: HistoryRange
  onRange?: (range: HistoryRange) => void
  /** Which ranges can be picked; all of them when undefined */
  applies?: (range: HistoryRange) => boolean
}

function HistoryHeader({ title, range, onRange, applies }: HistoryHeaderProps) {
  return (
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <div className="flex items-center gap-x-1" role="group" aria-label="Time range">
          {HISTORY_RANGES.map(({ value, label }) => (
            <Button
              key={value}
              size="sm"
              variant={range === value ? 'secondary' : 'ghost'}
              className="h-7 px-2.5"
              aria-pressed={range === value}
              disabled={!onRange || (applies && !applies(value))}
              onClick={() => onRange?.(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Click a point to time travel.</p>
    </CardHeader>
  )
}

/**
 * The charts' places while their first points load: label, figure and plot of each, and the
 * card's "Chart data sampled every …" note.
 */
function MetricChartsSkeleton({ metrics, stacked }: { metrics: MetricSpec[]; stacked?: boolean }) {
  return (
    <div aria-busy>
      <div className={CHARTS_GRID(metrics.length, stacked)}>
        {metrics.map((metric) => (
          <div key={metric.key}>
            <p className="text-sm font-medium text-muted-foreground">{metric.label}</p>
            <p className="text-xl font-semibold">
              <SkeletonText className="w-20" />
            </p>
            <Skeleton className="mt-2 h-40" />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-end text-xs">
        <SkeletonText className="w-44 opacity-60" />
      </div>
    </div>
  )
}

/** The History card before it knows whether the node serves past rounds, or anything to chart. */
export function TotalsHistorySkeleton({
  target,
  title,
  className,
  stacked,
}: Omit<TotalsHistoryProps, 'target'> & { target?: TotalsTarget }) {
  return (
    <Card className={className}>
      <HistoryHeader title={title} range={DEFAULT_RANGE} />
      <CardContent>
        <MetricChartsSkeleton metrics={metricsFor(target ?? { validator: 0 })} stacked={stacked} />
      </CardContent>
    </Card>
  )
}

const DEFAULT_RANGE: HistoryRange = '1m'

/**
 * Stake and stakers over time, one small chart per measure (they don't share a scale), ending at
 * the round on screen. Clicking a point opens the app at that round.
 */
// Memoized: on the dashboard it sits beside tables that re-render for every batch of data, and
// redrawing the chart with them is wasted work. Pass a stable `target`.
export const TotalsHistory = React.memo(function TotalsHistory({
  target,
  title,
  className,
  stacked,
}: TotalsHistoryProps) {
  const supportQuery = useQuery(timeTravelSupportQueryOptions)
  const { round } = useAtRound()
  const [range, setRange] = React.useState<HistoryRange>(DEFAULT_RANGE)

  const supported = !!supportQuery.data?.supported
  // The connected account's own stakes load first
  const ownStakesFirst = useOwnStakesFirst()

  // The target's whole history: which ranges apply, and what each range's window is cut from
  const extentQuery = useQuery({
    ...seriesExtentQueryOptions(target, round),
    enabled: supported && ownStakesFirst,
    placeholderData: keepSameTarget(target),
  })
  const extent = extentQuery.data
  // A range longer than the history (another validator's, or an earlier round's) would be All
  const shown = extent && !rangeApplies(range, extent) ? 'all' : range
  const applies = React.useCallback(
    (value: HistoryRange) => !extent || rangeApplies(value, extent),
    [extent],
  )

  if (!supported) {
    // Room for the card until the node says whether it can serve past rounds
    return supportQuery.isPending ? (
      <TotalsHistorySkeleton
        target={target}
        title={title}
        className={className}
        stacked={stacked}
      />
    ) : null
  }

  return (
    <Card className={className}>
      <HistoryHeader title={title} range={shown} onRange={setRange} applies={applies} />
      <CardContent>
        {/* Keyed by range: a new range starts from skeletons, with nothing of the old one kept */}
        <HistoryCharts
          key={shown}
          target={target}
          range={shown}
          extent={extentQuery.isPlaceholderData ? undefined : extent}
          extentError={extentQuery.error}
          stacked={stacked}
        />
      </CardContent>
    </Card>
  )
})

interface HistoryChartsProps {
  target: TotalsTarget
  range: HistoryRange
  /** Undefined while it loads */
  extent: SeriesExtent | null | undefined
  /** Why the extent failed to load, if it did */
  extentError: Error | null
  stacked?: boolean
}

/**
 * One range's charts. They load in two passes: a coarse one that draws the shape fast, then the
 * rest of the points, with a small spinner in the corner meanwhile. A new round keeps the old
 * charts up until the new ones draw.
 */
function HistoryCharts({ target, range, extent, extentError, stacked }: HistoryChartsProps) {
  const setRound = useSetRound()

  const windowQuery = useQuery({
    ...seriesWindowQueryOptions(target, range, extent),
    placeholderData: keepSameTarget(target),
  })
  const span = windowQuery.data
  const coarseQuery = useQuery({
    ...totalsSeriesPartQueryOptions(target, span, 'coarse'),
    placeholderData: keepSameTarget(target),
  })
  const fillQuery = useQuery({
    ...totalsSeriesPartQueryOptions(target, span, 'fill'),
    enabled: !!span && coarseQuery.isSuccess && !coarseQuery.isPlaceholderData,
    placeholderData: keepSameTarget(target),
  })

  // An old chart is shown whole until the new coarse pass lands, never mixed with it
  const fill =
    fillQuery.isPlaceholderData && !coarseQuery.isPlaceholderData ? undefined : fillQuery.data
  const points = React.useMemo(() => {
    if (span === null) return []
    const coarse = coarseQuery.data ?? []
    return fill ? mergeSeries(coarse, fill) : coarse
  }, [span, coarseQuery.data, fill])

  // Pending until the coarse pass draws; refining while the rest of the points load
  const pending =
    windowQuery.isPending || (span !== null && coarseQuery.isPending && !coarseQuery.data)
  // The first of the extent, window and coarse reads to fail, if any
  const failure =
    extentError ??
    windowQuery.error ??
    (coarseQuery.isError && !coarseQuery.data ? coarseQuery.error : null)
  const failed = failure !== null
  const refining =
    !pending &&
    !failed &&
    span !== null &&
    (windowQuery.isPlaceholderData ||
      coarseQuery.isPlaceholderData ||
      fillQuery.isPlaceholderData ||
      fillQuery.isPending) &&
    !fillQuery.isError

  // The points are evenly spaced in rounds, so the average gap in time is the gap between any two
  const sampling = React.useMemo(() => {
    if (points.length < 2) return undefined
    const elapsed = points[points.length - 1].timestamp - points[0].timestamp
    return formatSampleInterval(elapsed / (points.length - 1))
  }, [points])

  const data = React.useMemo(
    () =>
      points.map((point) => ({
        date: dayjs.unix(point.timestamp).format(range === '1m' ? 'MMM D' : 'll'),
        round: point.round.toString(),
        staked: point.staked,
        stakers: point.stakers,
        validators: point.validators ?? 0,
      })),
    [points, range],
  )

  const metrics = metricsFor(target)

  if (failed) {
    return <ReadFailure title="Couldn't load history" error={failure} />
  }
  if (pending) {
    return <MetricChartsSkeleton metrics={metrics} stacked={stacked} />
  }
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No history in this range.</p>
  }

  return (
    <div aria-busy={refining}>
      <div className={CHARTS_GRID(metrics.length, stacked)}>
        {metrics.map((metric) => (
          <MetricChart
            key={metric.key}
            data={data}
            metric={metric}
            onPick={(picked) => setRound(picked)}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
        {fillQuery.isError && (
          <p className="text-muted-foreground">
            Showing fewer points: couldn&apos;t load the rest.
          </p>
        )}
        <div className="ml-auto flex items-center gap-x-1.5 text-[11px] text-muted-foreground/60">
          {refining && (
            <span role="status" aria-label="Loading more points">
              <Loading inline size="sm" className="h-3 w-3" />
            </span>
          )}
          {sampling && <p>Chart data sampled every {sampling}</p>}
        </div>
      </div>
    </div>
  )
}

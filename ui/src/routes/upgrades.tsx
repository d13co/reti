import { createFileRoute, Link } from '@tanstack/react-router'
import { ChevronRight, MessageCircleWarning } from 'lucide-react'
import * as React from 'react'
import { useAtRound } from '@/hooks/useAtRound'
import { AlgoSymbol } from '@/components/AlgoSymbol'
import { DebouncedSearch } from '@/components/DebouncedSearch'
import { ErrorAlert } from '@/components/ErrorAlert'
import { Loading } from '@/components/Loading'
import { Meta } from '@/components/Meta'
import { PageHeader } from '@/components/PageHeader'
import { PageMain } from '@/components/PageMain'
import { Tooltip } from '@/components/Tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useNodeUpgrades } from '@/hooks/useNodeUpgrades'
import { useStableBy } from '@/hooks/useStableBy'
import { useValidatorNames } from '@/hooks/useValidatorNames'
import { AlgodVersion, nodemgrVersion } from '@/utils/algodVersion'
import { dayjs } from '@/utils/dayjs'
import { ellipseAddress } from '@/utils/ellipseAddress'
import { ExplorerLink } from '@/utils/explorer'
import { compactFormat } from '@/utils/format'
import {
  adoptedAt,
  firstReached,
  isBehind,
  LANE_SORTS,
  laneReleases,
  LaneSort,
  NodeUpgrade,
  ReleaseColor,
  releaseColors,
  sortLanes,
  UPGRADE_WINDOWS,
  upgradeKind,
  UpgradeKind,
  UpgradeWindow,
  ValidatorLane,
} from '@/utils/upgrades'
import { cn } from '@/utils/ui'

export const Route = createFileRoute('/upgrades')({
  component: NodeUpgradesPage,
})

/** Upgrades listed before "Show all" */
const LIST_PREVIEW = 100

function NodeUpgradesPage() {
  return (
    <>
      <Meta title="Node Upgrades" />
      <PageHeader
        title="Node Upgrades"
        description="When each validator's nodes moved to a new algod version, as their node daemons reported it to their pools."
      />
      <PageMain>
        <UpgradesBody />
      </PageMain>
    </>
  )
}

function UpgradesBody() {
  const { round } = useAtRound()
  const [storedWindow, setWindow] = useLocalStorage<UpgradeWindow>('upgrades-window', '3mo')
  // A stored value this version doesn't know falls back to the default
  const window = UPGRADE_WINDOWS.some((option) => option.value === storedWindow)
    ? storedWindow
    : '3mo'
  const [storedEligible, setEligibleOnly] = useLocalStorage<boolean>('upgrades-eligible', true)
  const [storedBehind, setBehindOnly] = useLocalStorage<boolean>('upgrades-behind', false)
  const eligibleOnly = storedEligible !== false
  const behindOnly = storedBehind === true
  const [storedSort, setSort] = useLocalStorage<LaneSort>('upgrades-sort', 'stake')
  const sort = LANE_SORTS.some((option) => option.value === storedSort) ? storedSort : 'stake'
  const [query, setQuery] = React.useState('')
  const result = useNodeUpgrades({ window, eligibleOnly })
  const { upgrades, lanes, progress, loading, fromTime, toTime } = result

  // Each of these is kept while its content is the same, as `lanes` is rebuilt as pools land and
  // a new one would render every lane again
  const laneIds = lanes.map((lane) => lane.validatorId)
  const validatorIds = useStableBy(laneIds, laneIds.join(','))
  const names = useValidatorNames(validatorIds, result.validators, round)
  // An NFD name, else the owner's address as the dashboard shows it
  const owners = React.useMemo(
    () => new Map(result.validators?.map((v) => [v.id, v.config.owner])),
    [result.validators],
  )
  const nameOf = React.useCallback(
    (id: number) => names.get(id) ?? ellipseAddress(owners.get(id)) ?? `Validator ${id}`,
    [names, owners],
  )
  const stakes = React.useMemo(
    () => new Map(result.validators?.map((v) => [v.id, v.state.totalAlgoStaked])),
    [result.validators],
  )

  // Colours come from every lane, so filtering never repaints the ones left
  const allColors = React.useMemo(() => releaseColors(laneReleases(lanes)), [lanes])
  // Its releases, in order, are all a colour depends on
  const colors = useStableBy(allColors, [...allColors.keys()].join(','))
  // The newest release on screen: the last, as the colours are oldest first
  const latest = [...colors.keys()].pop()
  // When the first validator in view reached each release
  const reached = React.useMemo(() => firstReached(lanes), [lanes])
  const firstTimes = useStableBy(reached, [...reached].join(';'))
  // The release picked in the legend, whose segments keep their colour while the rest go muted,
  // and which the "behind" and adoption orders measure against
  const [picked, setPicked] = React.useState<string>()
  const focus = picked !== undefined && colors.has(picked) ? picked : undefined
  // A picked release orders the lanes by who reached it or a newer one
  const sortRelease = sort === 'stake' ? undefined : focus

  // The validators the search and "behind" filter leave, for the lanes and the list alike
  const shown = React.useMemo(() => {
    const words = query.trim().toLowerCase()
    return new Set(
      lanes
        .filter((lane) => {
          if (behindOnly && !isBehind(lane.current?.release, latest)) return false
          if (!words) return true
          const id = lane.validatorId
          return [nameOf(id), owners.get(id) ?? '', String(id)].some((text) =>
            text.toLowerCase().includes(words),
          )
        })
        .map((lane) => lane.validatorId),
    )
  }, [lanes, query, behindOnly, latest, nameOf, owners])
  const shownLanes = React.useMemo(
    () => lanes.filter((lane) => shown.has(lane.validatorId)),
    [lanes, shown],
  )
  const shownUpgrades = React.useMemo(
    () => upgrades.filter((upgrade) => shown.has(upgrade.validatorId)),
    [upgrades, shown],
  )

  if (result.supported === false) {
    return (
      <div className="py-10">
        <Alert className="max-w-xl">
          <MessageCircleWarning className="h-5 w-5 -mt-1" />
          <AlertTitle>Node upgrades aren&apos;t available</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            The upgrade history is read from past on-chain state, which needs a read node with time
            travel. This node only serves the latest state.
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="py-10 space-y-8">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
          <Select value={window} onValueChange={(value) => setWindow(value as UpgradeWindow)}>
            <SelectTrigger className="w-[150px]" aria-label="Time window">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UPGRADE_WINDOWS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DebouncedSearch
            placeholder="Search validators..."
            aria-label="Search validators"
            value={query}
            onSearch={(value) => setQuery(String(value))}
            className="w-full sm:w-64"
          />
          <Select value={sort} onValueChange={(value) => setSort(value as LaneSort)}>
            <SelectTrigger className="w-auto min-w-[210px]" aria-label="Sort validators">
              <span className="text-muted-foreground">Sort:</span>
              <span className="flex-1 whitespace-nowrap pl-1 text-left">
                <SelectValue />
                {sortRelease !== undefined && (
                  <span className="text-muted-foreground">
                    {' '}
                    vs <span className="font-mono">{sortRelease}</span>
                  </span>
                )}
              </span>
            </SelectTrigger>
            <SelectContent>
              {LANE_SORTS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-x-2">
            <Checkbox
              id="upgrades-eligible"
              checked={eligibleOnly}
              onCheckedChange={(checked) => setEligibleOnly(!!checked)}
            />
            <label htmlFor="upgrades-eligible" className="text-sm font-medium leading-none">
              {round === undefined
                ? 'Currently eligible pools only'
                : 'Pools eligible at this round only'}
            </label>
          </div>
          <div className="flex items-center gap-x-2">
            <Checkbox
              id="upgrades-behind"
              checked={behindOnly}
              onCheckedChange={(checked) => setBehindOnly(!!checked)}
            />
            <label htmlFor="upgrades-behind" className="text-sm font-medium leading-none">
              Behind latest only
            </label>
          </div>
          {loading && (
            // The count changes several times a second: the status below announces only the
            // start and end
            <p className="flex items-center gap-x-2 text-sm text-muted-foreground" aria-hidden>
              <Loading size="sm" inline />
              {progress.total === 0
                ? 'Finding the pools…'
                : `Scanning pools: ${progress.done} of ${progress.total}`}
            </p>
          )}
          <p className="sr-only" role="status">
            {loading ? 'Loading node upgrades' : 'Node upgrades loaded'}
          </p>
        </div>
      </div>

      {result.error !== undefined && (
        <div className="space-y-2">
          <ErrorAlert
            title="Couldn't load every pool's history"
            message={result.error instanceof Error ? result.error.message : String(result.error)}
          />
          <Button variant="outline" size="sm" onClick={result.retry}>
            Try again
          </Button>
        </div>
      )}

      {fromTime !== undefined && toTime !== undefined && (
        <Lanes
          lanes={shownLanes}
          total={lanes.length}
          stakes={stakes}
          sort={sort}
          sortRelease={sortRelease}
          focus={focus}
          onPick={setPicked}
          colors={colors}
          latest={latest}
          firstTimes={firstTimes}
          fromTime={fromTime}
          toTime={toTime}
          nameOf={nameOf}
          loading={loading}
        />
      )}

      <UpgradeList
        upgrades={shownUpgrades}
        filtered={shownUpgrades.length < upgrades.length}
        nameOf={nameOf}
        loading={loading}
      />
    </div>
  )
}

/** The narrowest a lane segment is drawn, so a release held briefly (or just reached) shows */
const MIN_SEGMENT_PX = 6

/** The lanes' columns: validator, lane, current release */
const LANE_GRID =
  'grid grid-cols-[10rem_1fr_3.5rem] sm:grid-cols-[18rem_1fr_4rem] items-center gap-x-3'

interface LanesProps {
  /** The lanes the filters leave */
  lanes: ValidatorLane[]
  /** How many lanes there are before filtering */
  total: number
  /** Each validator's total stake at the round on screen */
  stakes: Map<number, bigint>
  sort: LaneSort
  /** The release the lanes are ordered against, if any */
  sortRelease?: string
  /** The release picked in the legend, if any */
  focus?: string
  onPick: (release: string | undefined) => void
  colors: Map<string, ReleaseColor>
  latest?: string
  /** When the first validator moved onto the latest release */
  /** When the first validator reached each release */
  firstTimes: Map<string, number>
  fromTime: number
  toTime: number
  nameOf: (id: number) => string
  /** Still finding or scanning the pools */
  loading: boolean
}

/** One lane per validator: its oldest pool version over the window, with a tick per upgrade. */
function Lanes({
  lanes,
  total,
  stakes,
  sort,
  sortRelease,
  focus,
  onPick,
  colors,
  latest,
  firstTimes,
  fromTime,
  toTime,
  nameOf,
  loading,
}: LanesProps) {
  const sorted = React.useMemo(
    () => sortLanes(lanes, sort, stakes, sortRelease),
    [lanes, sort, stakes, sortRelease],
  )
  const span = Math.max(1, toTime - fromTime)
  const at = React.useCallback(
    (time: number) => `${((Math.min(Math.max(time, fromTime), toTime) - fromTime) / span) * 100}%`,
    [fromTime, toTime, span],
  )
  const ticks = Array.from({ length: 5 }, (_, i) => fromTime + (span * i) / 4)
  const tickFormat = span > 60 * 60 * 24 * 400 ? 'MMM YYYY' : 'MMM D'

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="flex-1 text-lg font-semibold">
          Validators{' '}
          <span className="font-normal text-muted-foreground">
            ({lanes.length < total ? `${lanes.length} of ${total}` : total})
          </span>
        </h2>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="algod releases">
          {[...colors].map(([release, color]) => (
            <li key={release}>
              <button
                type="button"
                aria-pressed={focus === release}
                title={
                  focus === release
                    ? `Show every release${sortRelease === release ? ' and the usual order' : ''}`
                    : `Pick out ${release}${sort === 'stake' ? '' : ' and order by it'}`
                }
                onClick={() => onPick(focus === release ? undefined : release)}
                className={cn(
                  '-mx-1 flex items-center gap-x-1.5 rounded-sm px-1 py-0.5 transition-opacity hover:bg-muted',
                  focus === release && 'bg-muted',
                  focus !== undefined && focus !== release && 'opacity-40',
                )}
              >
                <span
                  className="h-3 w-3 rounded-sm bg-[--release-light] dark:bg-[--release-dark]"
                  style={releaseStyle(color)}
                  aria-hidden
                />
                <span className="font-mono">{release}</span>
                {/* The order counts validators past it too, though only it keeps its colour */}
                {sortRelease === release && !color.latest && (
                  <span className="text-muted-foreground">or newer</span>
                )}
                {color.latest && <span className="text-muted-foreground">latest</span>}
              </button>
            </li>
          ))}
          <li className="flex items-center gap-x-1.5">
            <BehindDot />
            <span>Not on the latest</span>
          </li>
        </ul>
      </div>
      <p className="text-sm text-muted-foreground">
        Each lane shows the oldest version among the validator&apos;s pools; ticks mark upgrades.
        Open a validator for its upgrades and pools.
      </p>
      {sorted.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          {total > 0
            ? 'No validators match.'
            : loading
              ? 'Scanning the pools…'
              : 'No pools have reported a version yet.'}
        </p>
      ) : (
        <div className="space-y-1">
          {sorted.map((lane) => (
            <LaneRow
              key={lane.validatorId}
              lane={lane}
              name={nameOf(lane.validatorId)}
              stake={stakes.get(lane.validatorId)}
              colors={colors}
              latest={latest}
              firstTimes={firstTimes}
              fromTime={fromTime}
              focus={focus}
              at={at}
            />
          ))}
          <div className={cn(LANE_GRID, 'pt-1 text-xs text-muted-foreground')}>
            <span />
            <div className="relative h-4">
              {ticks.map((tick, i) => (
                <span
                  key={tick}
                  className={cn(
                    'absolute whitespace-nowrap',
                    i === 0
                      ? ''
                      : i === ticks.length - 1
                        ? '-translate-x-full'
                        : // A phone's lane is too narrow for more than its two ends
                          'hidden -translate-x-1/2 sm:block',
                  )}
                  style={{ left: at(tick) }}
                >
                  {dayjs.unix(tick).format(tickFormat)}
                </span>
              ))}
            </div>
            <span />
          </div>
        </div>
      )}
    </section>
  )
}

/** Marks a validator whose oldest pool isn't on the newest release on screen. */
function BehindDot({ label }: { label?: string }) {
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#fab219]"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}

function formatStake(microalgos: bigint): string {
  return compactFormat.format(Number(microalgos) / 1e6)
}

interface LaneRowProps {
  lane: ValidatorLane
  name: string
  stake?: bigint
  colors: Map<string, ReleaseColor>
  latest?: string
  /** When the first validator reached each release */
  firstTimes: Map<string, number>
  fromTime: number
  /** The release picked in the legend: the others go muted */
  focus?: string
  /** Where a time falls along the lane, as a CSS length */
  at: (time: number) => string
}

const LaneRow = React.memo(function LaneRow({
  lane,
  name,
  stake,
  colors,
  latest,
  firstTimes,
  fromTime,
  focus,
  at,
}: LaneRowProps) {
  const [open, setOpen] = React.useState(false)
  const detailsId = React.useId()
  // Longest first, so a short segment widened to the minimum paints over its neighbours
  const paintOrder = React.useMemo(
    () =>
      lane.segments
        .map((segment, i) => ({ segment, last: i === lane.segments.length - 1 }))
        .sort((a, b) => b.segment.end - b.segment.start - (a.segment.end - a.segment.start)),
    [lane.segments],
  )
  const behind = isBehind(lane.current?.release, latest)

  return (
    <div>
      <div className={cn(LANE_GRID, 'text-sm')}>
        <div className="flex min-w-0 items-center gap-x-1.5">
          <button
            type="button"
            className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={`${open ? 'Hide' : 'Show'} upgrades and pools of ${name}`}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
          </button>
          <span className="flex w-2 shrink-0 justify-center">
            {behind && (
              <Tooltip content={`Oldest pool on ${lane.current?.release}; latest is ${latest}`}>
                <span className="flex">
                  <BehindDot label="Not on the latest release" />
                </span>
              </Tooltip>
            )}
          </span>
          <Link
            to="/validators/$validatorId"
            params={{ validatorId: String(lane.validatorId) }}
            className="min-w-0 flex-1 truncate link underline-offset-4"
            preload="intent"
            title={name}
          >
            {name}
          </Link>
          {stake !== undefined && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              <AlgoSymbol />
              {formatStake(stake)}
            </span>
          )}
        </div>
        <div
          className="relative h-5 overflow-hidden rounded-sm bg-muted cursor-pointer"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="sr-only">
            {lane.segments
              .flatMap((segment) =>
                segment.version
                  ? [
                      `${segment.version.release} from ${dayjs.unix(segment.start).format('ll')} to ${dayjs.unix(segment.end).format('ll')}`,
                    ]
                  : [],
              )
              .join('; ')}
          </span>
          {paintOrder.map(({ segment, last }) =>
            segment.version ? (
              <Tooltip
                key={segment.start}
                content={`${segment.version.release} · ${dayjs.unix(segment.start).format('ll')} – ${dayjs.unix(segment.end).format('ll')}`}
              >
                <div
                  className={cn(
                    'absolute inset-y-0 bg-[--release-light] dark:bg-[--release-dark] transition-opacity',
                    focus !== undefined && focus !== segment.version.release && 'opacity-15',
                  )}
                  style={{
                    // The last one keeps to the lane's end however much its minimum widens it
                    ...(last ? { right: 0 } : { left: at(segment.start) }),
                    width: `max(${MIN_SEGMENT_PX}px, calc(${last ? '100%' : at(segment.end)} - ${at(segment.start)}))`,
                    ...releaseStyle(colors.get(segment.version.release)),
                  }}
                />
              </Tooltip>
            ) : null,
          )}
          {lane.upgrades.map((upgrade) => (
            <Tooltip
              key={`${upgrade.round}:${upgrade.node}:${upgrade.to.full}`}
              content={upgradeSummary(upgrade)}
            >
              <span
                className="absolute inset-y-0 w-2 -translate-x-1"
                // No further right than where the last segment's minimum width starts, so it marks
                // that segment's start rather than covering it
                style={{ left: `min(${at(upgrade.timestamp)}, calc(100% - ${MIN_SEGMENT_PX}px))` }}
                aria-hidden
              >
                <span className="mx-auto block h-full w-0.5 bg-background" />
              </span>
            </Tooltip>
          ))}
        </div>
        <span
          className={cn('font-mono text-xs', behind ? 'text-foreground' : 'text-muted-foreground')}
        >
          {lane.current?.release ?? '--'}
        </span>
      </div>
      {open && (
        <LaneDetails
          id={detailsId}
          lane={lane}
          latest={latest}
          firstTimes={firstTimes}
          fromTime={fromTime}
        />
      )}
    </div>
  )
})

/** A validator's upgrades over the window and its pools as they stand at its end. */
interface LaneDetailsProps {
  id: string
  lane: ValidatorLane
  latest?: string
  /** When the first validator reached each release */
  firstTimes: Map<string, number>
  fromTime: number
}

function LaneDetails({ id, lane, latest, firstTimes, fromTime }: LaneDetailsProps) {
  return (
    <div
      id={id}
      className="mt-1 mb-3 grid gap-4 rounded-md border bg-muted/30 p-3 text-sm lg:grid-cols-2"
    >
      {latest !== undefined && (
        <p className="lg:col-span-2">
          <Adoption lane={lane} latest={latest} firstTimes={firstTimes} fromTime={fromTime} />
        </p>
      )}
      <div className="min-w-0 space-y-2">
        <h3 className="font-medium">
          Upgrades{' '}
          <span className="font-normal text-muted-foreground">({lane.upgrades.length})</span>
        </h3>
        {lane.upgrades.length === 0 ? (
          <p className="text-muted-foreground">None in this window.</p>
        ) : (
          <ol className="space-y-2">
            {lane.upgrades.map((upgrade) => {
              const kind = upgradeKind(upgrade)
              return (
                <li
                  key={`${upgrade.round}:${upgrade.node}:${upgrade.to.full}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5"
                >
                  <Tooltip content={`Round ${upgrade.round}`}>
                    <span className="whitespace-nowrap">
                      {dayjs.unix(upgrade.timestamp).format('lll')}
                    </span>
                  </Tooltip>
                  <span className="text-muted-foreground whitespace-nowrap">
                    {upgrade.node ? `Node ${upgrade.node}` : 'Unassigned'} ·{' '}
                    {poolsAndChanges(upgrade)}
                  </span>
                  <Tooltip content={upgrade.to.full}>
                    <span className="font-mono whitespace-nowrap">
                      {upgrade.from.length > 0 && (
                        <span className="text-muted-foreground">{releases(upgrade.from)} → </span>
                      )}
                      {upgrade.to.release}
                    </span>
                  </Tooltip>
                  <KindBadge kind={kind} />
                </li>
              )
            })}
          </ol>
        )}
      </div>
      <div className="min-w-0 space-y-2">
        <h3 className="font-medium">
          Pools <span className="font-normal text-muted-foreground">({lane.pools.length})</span>
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Pool</th>
                <th className="py-1 pr-3 font-medium">Node</th>
                <th className="py-1 pr-3 font-medium">Stake</th>
                <th className="py-1 pr-3 font-medium">algod</th>
                <th className="py-1 font-medium">Node daemon</th>
              </tr>
            </thead>
            <tbody>
              {lane.pools.map((pool) => (
                <tr key={String(pool.poolAppId)} className="border-t border-border/60">
                  <td className="py-1 pr-3">
                    <a
                      href={ExplorerLink.app(pool.poolAppId)}
                      target="_blank"
                      rel="noreferrer"
                      className="link font-mono"
                    >
                      {String(pool.poolAppId)}
                    </a>
                  </td>
                  <td className="py-1 pr-3">{pool.node ?? '--'}</td>
                  <td className="py-1 pr-3 whitespace-nowrap tabular-nums">
                    {pool.stake !== undefined ? (
                      <>
                        <AlgoSymbol />
                        {formatStake(pool.stake)}
                      </>
                    ) : (
                      '--'
                    )}
                  </td>
                  <td className="py-1 pr-3 font-mono whitespace-nowrap">
                    {pool.version ? (
                      <Tooltip content={pool.version.full}>
                        <span className="inline-flex items-center gap-x-1.5">
                          {isBehind(pool.version.release, latest) && <BehindDot />}
                          {pool.version.release}
                        </span>
                      </Tooltip>
                    ) : (
                      <span className="text-muted-foreground">Not reported</span>
                    )}
                  </td>
                  <td className="py-1 font-mono whitespace-nowrap">
                    {(pool.version && nodemgrVersion(pool.version)) ?? '--'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/** A gap in seconds, roughly: hours under two days, days after. */
function formatLag(seconds: number): string {
  const hours = seconds / 3600
  if (hours < 1) return 'under an hour'
  if (hours < 48) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * When the validator moved onto the release it's on, and how long after the first validator to
 * reach that release; and whether it's on the latest yet.
 */
function Adoption({ lane, latest, firstTimes, fromTime }: Omit<LaneDetailsProps, 'id'>) {
  const current = lane.current?.release
  if (current === undefined) return null
  const adopted = adoptedAt(lane, current)
  const first = firstTimes.get(current)
  const behind = isBehind(current, latest)
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      {behind && (
        <>
          <BehindDot />
          <span>
            Not on <span className="font-mono">{latest}</span> yet.
          </span>
        </>
      )}
      <span>
        On <span className="font-mono">{current}</span>{' '}
        {adopted === undefined || adopted <= fromTime
          ? 'since before this window'
          : `since ${dayjs.unix(adopted).format('lll')}`}
      </span>
      {adopted !== undefined && adopted > fromTime && first !== undefined && first > fromTime && (
        <span className="text-muted-foreground">
          ·{' '}
          {adopted > first
            ? `${formatLag(adopted - first)} after the first validator on it`
            : 'the first validator on it'}
        </span>
      )}
    </span>
  )
}

function KindBadge({ kind }: { kind: UpgradeKind }) {
  const badge = (
    <Badge
      variant={kind === 'downgrade' ? 'destructive' : kind === 'upgrade' ? 'outline' : 'secondary'}
    >
      {KIND_LABELS[kind]}
    </Badge>
  )
  const hint = KIND_HINTS[kind]
  if (!hint) return badge
  return (
    <Tooltip content={hint}>
      <span>{badge}</span>
    </Tooltip>
  )
}

/** A release's colours as the variables its swatch's theme classes read. */
function releaseStyle(color?: ReleaseColor): React.CSSProperties {
  return {
    '--release-light': color?.light,
    '--release-dark': color?.dark,
  } as React.CSSProperties
}

function releases(versions: AlgodVersion[]): string {
  return [...new Set(versions.map((version) => version.release))].join(', ')
}

function upgradeSummary(upgrade: NodeUpgrade): string {
  const from = upgrade.from.length > 0 ? releases(upgrade.from) : 'none'
  const node = upgrade.node ? `Node ${upgrade.node}` : 'Unassigned pool'
  const changes = upgrade.changes > 1 ? ` · ${upgrade.changes} changes` : ''
  return `${dayjs.unix(upgrade.timestamp).format('lll')} · ${node} · ${from} → ${upgrade.to.release}${changes}`
}

const KIND_LABELS: Record<UpgradeKind, string> = {
  upgrade: 'Upgrade',
  downgrade: 'Downgrade',
  nodemgr: 'Node daemon',
  other: 'Other',
  first: 'First report',
  flapping: 'Flapping',
}

const KIND_HINTS: Partial<Record<UpgradeKind, string>> = {
  other:
    'algod changed without moving up or down overall: another build of the same release, or pools coming from releases on both sides of the new one',
  flapping:
    'A pool went back and forth between versions, as when two nodes report for the same pool',
}

/** "3 pools", plus the number of changes when there were more than one per pool */
function poolsAndChanges(upgrade: NodeUpgrade): string {
  const pools = `${upgrade.pools.length} ${upgrade.pools.length === 1 ? 'pool' : 'pools'}`
  return upgrade.changes > upgrade.pools.length ? `${pools}, ${upgrade.changes} changes` : pools
}

const KINDS: UpgradeKind[] = ['upgrade', 'downgrade', 'nodemgr', 'other', 'flapping', 'first']

interface UpgradeListProps {
  upgrades: NodeUpgrade[]
  /** Whether the validator filters left some out */
  filtered: boolean
  nameOf: (id: number) => string
  loading: boolean
}

function UpgradeList({ upgrades, filtered, nameOf, loading }: UpgradeListProps) {
  const [showAll, setShowAll] = React.useState(false)
  const [kinds, setKinds] = React.useState<ReadonlySet<UpgradeKind>>(() => new Set(KINDS))
  const toggleKind = (kind: UpgradeKind) =>
    setKinds((current) => {
      const next = new Set(current)
      if (!next.delete(kind)) next.add(kind)
      return next
    })
  const matching = React.useMemo(
    () => upgrades.filter((upgrade) => kinds.has(upgradeKind(upgrade))),
    [upgrades, kinds],
  )
  const shown = showAll ? matching : matching.slice(0, LIST_PREVIEW)

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="flex-1 text-lg font-semibold">
          Upgrades <span className="text-muted-foreground font-normal">({matching.length})</span>
        </h2>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Upgrade types">
          {KINDS.map((kind) => (
            <Button
              key={kind}
              variant={kinds.has(kind) ? 'secondary' : 'ghost'}
              size="sm"
              className={cn('h-7 px-2.5 text-xs', !kinds.has(kind) && 'text-muted-foreground')}
              aria-pressed={kinds.has(kind)}
              onClick={() => toggleKind(kind)}
            >
              {KIND_LABELS[kind]}
            </Button>
          ))}
        </div>
      </div>
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Validator</TableHead>
              <TableHead>Node</TableHead>
              <TableHead>Pools</TableHead>
              <TableHead>algod</TableHead>
              <TableHead>Node daemon</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  {loading
                    ? 'Loading…'
                    : filtered || kinds.size < KINDS.length
                      ? 'No upgrades match'
                      : 'No upgrades in this window'}
                </TableCell>
              </TableRow>
            ) : (
              shown.map((upgrade) => (
                <UpgradeRow
                  key={`${upgrade.validatorId}:${upgrade.round}:${upgrade.node}:${upgrade.to.full}`}
                  upgrade={upgrade}
                  name={nameOf(upgrade.validatorId)}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {matching.length > shown.length && (
        <Button variant="outline" size="sm" onClick={() => setShowAll(true)}>
          Show all {matching.length}
        </Button>
      )}
    </section>
  )
}

const UpgradeRow = React.memo(function UpgradeRow({
  upgrade,
  name,
}: {
  upgrade: NodeUpgrade
  name: string
}) {
  const kind = upgradeKind(upgrade)
  const fromDaemons = [...new Set(upgrade.from.map(nodemgrVersion).filter(Boolean))].join(', ')
  const toDaemon = nodemgrVersion(upgrade.to)
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        <Tooltip content={`Round ${upgrade.round}`}>
          <span>{dayjs.unix(upgrade.timestamp).format('lll')}</span>
        </Tooltip>
      </TableCell>
      <TableCell className="max-w-[12rem] truncate">
        <Link
          to="/validators/$validatorId"
          params={{ validatorId: String(upgrade.validatorId) }}
          className="link underline-offset-4"
          preload="intent"
        >
          {name}
        </Link>
      </TableCell>
      <TableCell>{upgrade.node ?? '--'}</TableCell>
      <TableCell className="whitespace-nowrap">
        {upgrade.changes > upgrade.pools.length ? (
          <Tooltip
            content={`${upgrade.changes} changes until ${dayjs.unix(upgrade.endTimestamp).format('lll')}`}
          >
            <span>
              {upgrade.pools.length}{' '}
              <span className="text-muted-foreground">({upgrade.changes} changes)</span>
            </span>
          </Tooltip>
        ) : (
          upgrade.pools.length
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono">
        <Tooltip content={upgrade.to.full}>
          <span>
            {upgrade.from.length > 0 && (
              <span className="text-muted-foreground">{releases(upgrade.from)} → </span>
            )}
            {upgrade.to.release}
          </span>
        </Tooltip>
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono">
        {fromDaemons && fromDaemons !== toDaemon && (
          <span className="text-muted-foreground">{fromDaemons} → </span>
        )}
        {toDaemon ?? '--'}
      </TableCell>
      <TableCell>
        <KindBadge kind={kind} />
      </TableCell>
    </TableRow>
  )
})

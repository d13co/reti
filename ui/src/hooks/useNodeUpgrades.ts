import { FetchQueryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { allValidatorsQueryOptions, poolGlobalStatesQueryOptions } from '@/api/queries'
import {
  latestReadRound,
  roundTimestampQueryOptions,
  timeTravelSupportQueryOptions,
} from '@/api/reti'
import {
  algodHistoriesRestoreQueryOptions,
  PoolAlgodChanges,
  poolAlgodChangesQueryOptions,
} from '@/api/upgrades'
import { useAtRound } from '@/hooks/useAtRound'
import { useStableBy } from '@/hooks/useStableBy'
import { nodeNumForPoolId } from '@/utils/pools'
import { MIN_ELIGIBLE_STAKE } from '@/utils/table'
import {
  nodeUpgrades,
  NodeUpgrade,
  PoolVersionHistory,
  UpgradeWindow,
  validatorLanes,
  ValidatorLane,
  windowStartTime,
} from '@/utils/upgrades'

/** Pools listed at once. Each listing is one request, or a few for a pool with a long history. */
const SCAN_CONCURRENCY = 6

/** How often the page takes in the listings that finished since. */
const PROGRESS_INTERVAL = 250

/** How long the latest round anchors a live window before it is read again. */
const ANCHOR_STALE_TIME = 1000 * 60 // 1 minute

export interface NodeUpgradesOptions {
  window: UpgradeWindow
  /** Only the pools holding at least 30k ALGO at the round on screen */
  eligibleOnly: boolean
}

export interface NodeUpgradesResult {
  /** Whether the read node has the history this needs; undefined while it's being asked */
  supported?: boolean
  /** Still finding the pools or listing them */
  loading: boolean
  /** The window on screen, in seconds */
  fromTime?: number
  toTime?: number
  upgrades: NodeUpgrade[]
  lanes: ValidatorLane[]
  /** Pools listed (or failed), of those that have reported a version */
  progress: { done: number; total: number }
  error?: unknown
  /** Reads again what failed */
  retry: () => void
  /** The validators on screen, for their names */
  validators?: {
    id: number
    config: { nfdForInfo: bigint; owner: string }
    state: { totalAlgoStaked: bigint }
  }[]
}

/**
 * Fetches every query in `queries` through the cache, a few at a time, and re-renders as they
 * land (at most every {@link PROGRESS_INTERVAL}). Queries already holding fresh data cost
 * nothing. Starts over when `queries` changes, which must be memoized. Errors are read from the
 * queries' own state, so a restart doesn't hide them.
 */
function useFetchAll<T>(
  queries: FetchQueryOptions<T, Error, T, readonly unknown[]>[],
  concurrency: number,
  /** Bumped to fetch again the queries that failed */
  attempt: number,
): { data: (T | undefined)[]; settled: number; version: number; error?: Error } {
  const queryClient = useQueryClient()
  // Bumped as listings land, refreshes of data already there included
  const [version, setTick] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    let next = 0
    let dirty = false
    const timer = setInterval(() => {
      if (dirty) {
        dirty = false
        setTick((tick) => tick + 1)
      }
    }, PROGRESS_INTERVAL)
    const worker = async () => {
      while (!cancelled && next < queries.length) {
        const query = queries[next++]
        try {
          await queryClient.fetchQuery(query)
        } catch {
          // Read from the query's state below
        }
        dirty = true
      }
    }
    void Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
      clearInterval(timer)
      setTick((tick) => tick + 1)
    })
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [queries, concurrency, queryClient, attempt])

  const states = queries.map((query) => queryClient.getQueryState<T, Error>(query.queryKey))
  const data = states.map((state) => state?.data)
  const settled = states.filter(
    (state) => state?.data !== undefined || state?.status === 'error',
  ).length
  const error = states.find((state) => state?.status === 'error')?.error ?? undefined
  return { data, settled, version, error }
}

/** A pool that hasn't reported a version by the round on screen: it has no history to list. */
const NOT_REPORTED = Symbol('not reported')

/** One validator's upgrades and lane, and what they were built from. */
interface ValidatorBuild {
  inputs: unknown[]
  upgrades: NodeUpgrade[]
  lane?: ValidatorLane
}

const sameInputs = (a: unknown[], b: unknown[]) =>
  a.length === b.length && a.every((value, i) => Object.is(value, b[i]))

/**
 * The validator node upgrades over a window back from the time on screen: when each pool's node
 * daemon reported a new version, grouped into upgrades per node, and each validator's oldest
 * pool version over the window. Needs a dtalgorand read node with the versions `key` filter.
 */
export function useNodeUpgrades({ window, eligibleOnly }: NodeUpgradesOptions): NodeUpgradesResult {
  const queryClient = useQueryClient()
  const { round } = useAtRound()
  // The round on screen's own time. Not the viewed time, which lags a jump to another round
  const roundTimeQuery = useQuery(roundTimestampQueryOptions(round))
  const roundTime = round !== undefined ? roundTimeQuery.data : undefined

  const supportQuery = useQuery(timeTravelSupportQueryOptions)
  const support = supportQuery.data
  const supported = support?.supported

  const validatorsQuery = useQuery(allValidatorsQueryOptions(queryClient, round))
  const poolStatesQuery = useQuery({
    ...poolGlobalStatesQueryOptions(queryClient, round),
    enabled: supported === true,
  })
  // The pools' histories kept from earlier visits, loaded before any is listed
  const restoreQuery = useQuery({
    ...algodHistoriesRestoreQueryOptions(queryClient),
    enabled: supported === true,
  })
  const restored = restoreQuery.isSuccess

  // The round the window ends at, and its time: the round on screen, or the latest
  const latestQuery = useQuery({
    queryKey: ['upgrades-latest-round'],
    queryFn: async () => ({ round: await latestReadRound(), timestamp: Date.now() / 1000 }),
    staleTime: ANCHOR_STALE_TIME,
    enabled: supported === true && round === undefined,
  })
  const anchor =
    round !== undefined
      ? roundTime !== undefined
        ? { round, timestamp: roundTime }
        : undefined
      : latestQuery.data

  const validators = validatorsQuery.data
  const poolStates = poolStatesQuery.data

  // Every pool, with its validator, node, stake, whether it's eligible and whether its node
  // daemon has reported a version. Rebuilt on each refetch, as stakes move
  const allPools = React.useMemo(() => {
    if (!validators || !poolStates) return undefined
    return validators.flatMap((validator) =>
      validator.pools.flatMap((pool) => {
        const state = poolStates[String(pool.poolAppId)]
        if (!state) return []
        return [
          {
            poolAppId: pool.poolAppId,
            validatorId: validator.id,
            node: nodeNumForPoolId(pool.poolAppId, validator.nodePoolAssignment),
            stake: pool.totalAlgoStaked,
            eligible: state.balance >= MIN_ELIGIBLE_STAKE,
            // A daemon only ever writes a version, never clears one: a pool without one at the
            // round on screen has no changes up to it
            reported: Boolean(state.algodVer),
          },
        ]
      }),
    )
  }, [validators, poolStates])

  // The pools on screen. Kept the same while the same pools are picked, so a refetch that only
  // moves stakes doesn't start the listings over
  const picked = allPools?.filter((pool) => !eligibleOnly || pool.eligible)
  const pools = useStableBy(
    picked,
    picked
      ?.map((pool) => `${pool.poolAppId}:${pool.validatorId}:${pool.node}:${pool.reported}`)
      .join(',') ?? '',
  )
  const stakes = React.useMemo(
    () => new Map(allPools?.map((pool) => [pool.poolAppId, pool.stake])),
    [allPools],
  )

  const fromTime =
    anchor && support
      ? windowStartTime(window, anchor.timestamp, support.creationTimestamp)
      : undefined
  const toTime = anchor?.timestamp
  const anchorRound = anchor?.round

  // One listing per pool that has reported, once the kept histories are in. A history covers
  // every window, so changing the window lists nothing
  const listed = React.useMemo(
    () => (restored ? (pools ?? []).filter((pool) => pool.reported) : []),
    [pools, restored],
  )
  const scans = React.useMemo(
    () =>
      listed.map(
        (pool) =>
          poolAlgodChangesQueryOptions(queryClient, pool.poolAppId) as FetchQueryOptions<
            PoolAlgodChanges,
            Error,
            PoolAlgodChanges,
            readonly unknown[]
          >,
      ),
    [listed, queryClient],
  )
  const [attempt, setAttempt] = React.useState(0)
  const scanned = useFetchAll(scans, SCAN_CONCURRENCY, attempt)

  // Each validator's upgrades and lane, rebuilt only when one of its pools got new data (or the
  // window moved): the rest keep their objects, so their lanes don't render again
  const builds = React.useRef(new Map<number, ValidatorBuild>())
  const built = React.useMemo(() => {
    if (!pools || fromTime === undefined || toTime === undefined || anchorRound === undefined) {
      return undefined
    }
    const dataByPool = new Map(listed.map((pool, i) => [pool.poolAppId, scanned.data[i]]))
    const byValidator = new Map<number, NonNullable<typeof pools>>()
    for (const pool of pools) {
      const list = byValidator.get(pool.validatorId)
      if (list) list.push(pool)
      else byValidator.set(pool.validatorId, [pool])
    }
    const next = new Map<number, ValidatorBuild>()
    const upgrades: NodeUpgrade[] = []
    const lanes: ValidatorLane[] = []
    for (const [validatorId, validatorPools] of byValidator) {
      const parts = validatorPools.map((pool) =>
        pool.reported ? dataByPool.get(pool.poolAppId) : NOT_REPORTED,
      )
      const inputs: unknown[] = [fromTime, toTime, anchorRound]
      validatorPools.forEach((pool, i) =>
        inputs.push(pool.poolAppId, pool.node, stakes.get(pool.poolAppId), parts[i]),
      )
      let build = builds.current.get(validatorId)
      if (!build || !sameInputs(build.inputs, inputs)) {
        // Only pools listed so far: one still to come joins its validator when it lands
        const histories = validatorPools.flatMap((pool, i): PoolVersionHistory[] => {
          const part = parts[i]
          if (part === undefined) return []
          return [
            {
              poolAppId: pool.poolAppId,
              validatorId,
              node: pool.node,
              stake: stakes.get(pool.poolAppId),
              // Histories start at the pool's creation, before which it had no version
              base: '',
              changes: part === NOT_REPORTED ? [] : part.changes,
            },
          ]
        })
        const validatorUpgrades = nodeUpgrades(histories, fromTime, anchorRound)
        const [lane] = validatorLanes(histories, validatorUpgrades, fromTime, toTime, anchorRound)
        build = { inputs, upgrades: validatorUpgrades, lane }
      }
      next.set(validatorId, build)
      for (const upgrade of build.upgrades) upgrades.push(upgrade)
      if (build.lane) lanes.push(build.lane)
    }
    builds.current = next
    upgrades.sort((a, b) => b.timestamp - a.timestamp || Number(b.round - a.round))
    return { upgrades, lanes }
    // `scanned.data` is a new array each render; `scanned.version` says when it changed
  }, [pools, listed, stakes, fromTime, toTime, anchorRound, scanned.version, scans])

  const error =
    scanned.error ??
    restoreQuery.error ??
    roundTimeQuery.error ??
    latestQuery.error ??
    poolStatesQuery.error ??
    validatorsQuery.error
  // A read the rest waits on failed: the page stops loading and offers a retry. A failed listing
  // counts as settled, so it doesn't hold up the others
  const stuck =
    (anchor === undefined && (roundTimeQuery.isError || latestQuery.isError)) ||
    (!pools && (validatorsQuery.isError || poolStatesQuery.isError))
  const loading =
    supported !== false &&
    !stuck &&
    (anchor === undefined || !pools || !restored || scanned.settled < scans.length)
  const retry = React.useCallback(() => {
    // The page's own failed reads, then the failed listings, which nothing observes
    void queryClient.refetchQueries({
      type: 'active',
      predicate: (query) => query.state.status === 'error',
    })
    setAttempt((n) => n + 1)
  }, [queryClient])
  return {
    supported,
    loading,
    fromTime,
    toTime,
    upgrades: built?.upgrades ?? [],
    lanes: built?.lanes ?? [],
    progress: { done: scanned.settled, total: scans.length },
    error: error ?? undefined,
    retry,
    validators,
  }
}

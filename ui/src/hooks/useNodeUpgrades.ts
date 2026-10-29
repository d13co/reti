import { FetchQueryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { allValidatorsQueryOptions, poolGlobalStatesQueryOptions } from '@/api/queries'
import {
  latestReadRound,
  roundTimestampQueryOptions,
  timeTravelSupportQueryOptions,
} from '@/api/reti'
import {
  PoolAlgodChanges,
  poolAlgodChangesQueryOptions,
  poolAlgodVersionsAtQueryOptions,
} from '@/api/upgrades'
import { useAtRound } from '@/hooks/useAtRound'
import { nodeNumForPoolId } from '@/utils/pools'
import { MIN_ELIGIBLE_STAKE } from '@/utils/table'
import {
  nodeUpgrades,
  NodeUpgrade,
  PoolVersionHistory,
  roundAtOrBefore,
  spanStarts,
  UpgradeWindow,
  validatorLanes,
  ValidatorLane,
  windowStartTime,
} from '@/utils/upgrades'

/** Pools scanned at once. Each scan is a few requests in a row. */
const SCAN_CONCURRENCY = 6

/** How often the page takes in the scans that finished since. */
const PROGRESS_INTERVAL = 250

/** How long the latest round anchors a live window before it is read again. */
const ANCHOR_STALE_TIME = 1000 * 60 // 1 minute

/** The pools' versions before a window that starts at the registry's creation: none */
const EMPTY_BASE: Readonly<Record<string, string>> = {}

export interface NodeUpgradesOptions {
  window: UpgradeWindow
  /** Only the pools holding at least 30k ALGO at the round on screen */
  eligibleOnly: boolean
}

export interface NodeUpgradesResult {
  /** Whether the read node has the history this needs; undefined while it's being asked */
  supported?: boolean
  /** Still finding the pools or scanning them */
  loading: boolean
  /** The window on screen, in seconds */
  fromTime?: number
  toTime?: number
  upgrades: NodeUpgrade[]
  lanes: ValidatorLane[]
  /** Pool spans scanned (or failed), of those the window needs */
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
  // Bumped as scans land, refreshes of data already there included
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

/** Keeps the first `value` for as long as `key` stays the same. */
function useStableBy<T>(value: T, key: string): T {
  const ref = React.useRef({ key, value })
  if (ref.current.key !== key) ref.current = { key, value }
  return ref.current.value
}

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

  // Every pool, with its validator, node, stake and whether it's eligible. Rebuilt on each
  // refetch, as stakes move
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
          },
        ]
      }),
    )
  }, [validators, poolStates])

  // The pools to scan. Kept the same while the same pools are picked, so a refetch that only
  // moves stakes doesn't start the scans over
  const picked = allPools?.filter((pool) => !eligibleOnly || pool.eligible)
  const pools = useStableBy(
    picked,
    picked?.map((pool) => `${pool.poolAppId}:${pool.validatorId}:${pool.node}`).join(',') ?? '',
  )
  const stakes = React.useMemo(
    () => new Map(allPools?.map((pool) => [pool.poolAppId, pool.stake])),
    [allPools],
  )

  const fromTime =
    anchor && support
      ? windowStartTime(window, anchor.timestamp, support.creationTimestamp)
      : undefined
  const fromRound =
    anchor && fromTime !== undefined
      ? roundAtOrBefore(anchor.round, anchor.timestamp, fromTime, support?.creationRound)
      : undefined
  const anchorRound = anchor?.round

  // Kept the same while the same spans cover the window, as the live anchor moves every minute
  const spanList =
    fromRound !== undefined && anchorRound !== undefined ? spanStarts(fromRound, anchorRound) : []
  const spans = useStableBy(spanList, spanList.join(','))

  // One scan per pool and span
  const scans = React.useMemo(
    () =>
      (pools ?? []).flatMap((pool) =>
        spans.map(
          (start) =>
            poolAlgodChangesQueryOptions(queryClient, pool.poolAppId, start) as FetchQueryOptions<
              PoolAlgodChanges,
              Error,
              PoolAlgodChanges,
              readonly unknown[]
            >,
        ),
      ),
    [pools, spans, queryClient],
  )
  const [attempt, setAttempt] = React.useState(0)
  const scanned = useFetchAll(scans, SCAN_CONCURRENCY, attempt)

  // Every pool's version just before the first span, which its first change moved it from. Read
  // for all pools, picked or not, so changing which are picked doesn't read it again
  const baseRound = spans.length > 0 ? spans[0] - 1n : undefined
  const creationRound = support?.creationRound
  // Round 1 is the earliest there is, if the registry's creation isn't known
  const baseBeforeCreation = baseRound !== undefined && baseRound < (creationRound ?? 1n)
  const allPoolIdsKey = allPools?.map((pool) => String(pool.poolAppId)).join(',') ?? ''
  const allPoolIds = React.useMemo(
    () => (allPoolIdsKey ? allPoolIdsKey.split(',').map(BigInt) : []),
    [allPoolIdsKey],
  )
  const baseQuery = useQuery({
    ...poolAlgodVersionsAtQueryOptions(allPoolIds, baseRound ?? 0n),
    enabled: baseRound !== undefined && !baseBeforeCreation && allPoolIds.length > 0,
  })
  const base =
    baseBeforeCreation || (allPools !== undefined && allPools.length === 0)
      ? EMPTY_BASE
      : baseQuery.data

  // Only pools with every span scanned: a gap would compare a change against the wrong version
  const histories = React.useMemo((): PoolVersionHistory[] | undefined => {
    if (!pools || !base) return undefined
    return pools.flatMap((pool, p) => {
      const parts = spans.map((_, s) => scanned.data[p * spans.length + s])
      if (parts.some((part) => part === undefined)) return []
      return [
        {
          poolAppId: pool.poolAppId,
          validatorId: pool.validatorId,
          node: pool.node,
          stake: stakes.get(pool.poolAppId),
          base: base[String(pool.poolAppId)] ?? '',
          changes: parts.flatMap((part) => part?.changes ?? []),
        },
      ]
    })
    // `scanned.data` is a new array each render; `scanned.version` says when it changed
  }, [pools, base, spans, stakes, scanned.version, scans])

  const toTime = anchor?.timestamp
  const upgrades = React.useMemo(
    () =>
      histories && fromTime !== undefined && anchorRound !== undefined
        ? nodeUpgrades(histories, fromTime, anchorRound)
        : [],
    [histories, fromTime, anchorRound],
  )
  const lanes = React.useMemo(
    () =>
      histories && fromTime !== undefined && toTime !== undefined && anchorRound !== undefined
        ? validatorLanes(histories, upgrades, fromTime, toTime, anchorRound)
        : [],
    [histories, upgrades, fromTime, toTime, anchorRound],
  )

  const error =
    scanned.error ??
    baseQuery.error ??
    roundTimeQuery.error ??
    latestQuery.error ??
    poolStatesQuery.error ??
    validatorsQuery.error
  // A read the rest waits on failed: the page stops loading and offers a retry. A failed scan
  // counts as settled, so it doesn't hold up the others
  const stuck =
    (anchor === undefined && (roundTimeQuery.isError || latestQuery.isError)) ||
    (!pools && (validatorsQuery.isError || poolStatesQuery.isError)) ||
    (!base && baseQuery.isError)
  const loading =
    supported !== false &&
    !stuck &&
    (anchor === undefined || !pools || !base || scanned.settled < scans.length)
  const retry = React.useCallback(() => {
    // The page's own failed reads, then the failed scans, which nothing observes
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
    upgrades,
    lanes,
    progress: { done: scanned.settled, total: scans.length },
    error: error ?? undefined,
    retry,
    validators,
  }
}

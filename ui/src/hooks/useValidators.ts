import {
  useQueries,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  UseQueryResult,
} from '@tanstack/react-query'
import * as React from 'react'
import {
  allValidatorsQueryOptions,
  assetQueryOptions,
  nfdQueryOptions,
  nfdSupportQueryOptions,
  nodelyApyQueryOptions,
  nodelyPerfMetricsQueryOptions,
  poolGlobalStatesQueryOptions,
  realisedApyQueryOptions,
  validatorMetricsQueryOptions,
} from '@/api/queries'
import { timeTravelSupportQueryOptions } from '@/api/reti'
import { GatingType } from '@/constants/gating'
import { useAtRound } from '@/hooks/useAtRound'
import { useQueuedQueries } from '@/hooks/useQueuedQueries'
import { useExtrasReady } from '@/hooks/useExtrasReady'
import { useOwnStakesFirst } from '@/hooks/useOwnStakesFirst'
import { Validator } from '@/interfaces/validator'
import { AssembledValidators, assembleValidators, NO_VALIDATORS } from '@/utils/assembleValidators'

/**
 * Dedupes and sorts a list of ids, returning a referentially stable array while the
 * contents are unchanged.
 */
function useStableIds(ids: number[]): number[] {
  const unique = Array.from(new Set(ids)).sort((a, b) => a - b)
  const key = unique.join(',')
  const cache = React.useRef<{ key: string; ids: number[] }>({ key, ids: unique })

  if (cache.current.key !== key) {
    cache.current = { key, ids: unique }
  }

  return cache.current.ids
}

/** Each query's data, positionally aligned. Stable, so `useQueries` keeps its combined result. */
function dataOf<T>(results: UseQueryResult<T>[]): (T | undefined)[] {
  return results.map((result) => result.data)
}

/**
 * Fetches all validator data and enrichment data in parallel.
 */
export function useValidators(): {
  validators: Validator[]
  isLoading: boolean
  error: Error | undefined | null
} {
  const queryClient = useQueryClient()
  const { round, pinned } = useAtRound()

  // Every validator's config/state/pools/nodePoolAssignments in a single request
  const allValidatorsQuery = useSuspenseQuery(allValidatorsQueryOptions(queryClient, round))
  const validatorData = allValidatorsQuery.data

  // Enrichment lookups are queued rather than fired at once. The core data now lands in a
  // single tick, so an unthrottled useQueries here would issue every NFD lookup
  // simultaneously.
  //
  // The id lists are keyed on their own contents so a refetch that leaves them unchanged
  // (the common case - these rarely change) doesn't restart the batching queue.
  const rewardTokenIds = useStableIds(
    validatorData.map((validator) => Number(validator.config.rewardTokenId)).filter((id) => id > 0),
  )

  const gatingAssetIds = useStableIds(
    validatorData
      .flatMap((validator) =>
        validator.config.entryGatingType === GatingType.AssetId
          ? validator.config.entryGatingAssets
          : [],
      )
      .map(Number)
      .filter((id) => id > 0),
  )

  const nfdAppIds = useStableIds(
    validatorData.map((validator) => Number(validator.config.nfdForInfo)).filter((id) => id > 0),
  )

  const rewardTokenQueryOptions = React.useMemo(
    () => rewardTokenIds.map((id) => assetQueryOptions(id, round, queryClient)),
    [rewardTokenIds, round, queryClient],
  )

  // Loads last, with the extras: nothing in the table shows them. The list stays empty until
  // then, as the queue releases on a timer and would fire queries handed to it disabled at once.
  const extrasReady = useExtrasReady()
  const gatingAssetQueryOptions = React.useMemo(
    () =>
      extrasReady ? gatingAssetIds.map((id) => assetQueryOptions(id, round, queryClient)) : [],
    [extrasReady, gatingAssetIds, round, queryClient],
  )

  // Read on chain through the SDK, every validator's NFD shares one request, so they all go at
  // once; through the rate limited REST API they are metered. Waits for the answer to that.
  const nfdSupportQuery = useQuery(nfdSupportQueryOptions)
  const nfdQueryOptionsList = React.useMemo(
    () =>
      nfdSupportQuery.isPending
        ? []
        : nfdAppIds.map((id) => nfdQueryOptions(id, { view: 'full' }, {}, round)),
    [nfdAppIds, nfdSupportQuery.isPending, round],
  )

  // Unmetered, so they fire together: the SDK reads asset calls made within its batch window
  // (10 ms) at the same round in one request
  const rewardTokenQueries = useQueuedQueries(rewardTokenQueryOptions, {
    host: 'algod',
    metered: false,
  })
  const gatingAssetQueries = useQueuedQueries(gatingAssetQueryOptions, {
    host: 'algod',
    metered: false,
  })
  const nfdQueries = useQueuedQueries(nfdQueryOptionsList, {
    host: 'nfd',
    metered: nfdSupportQuery.data !== true,
  })

  // Every pool's lastPayout in one request, shared by all the metrics queries below. After the
  // connected account's own stakes: the metrics and APY columns that wait on it come second.
  const ownStakesFirst = useOwnStakesFirst()
  const poolGlobalStatesQuery = useQuery({
    ...poolGlobalStatesQueryOptions(queryClient, round),
    enabled: ownStakesFirst,
  })

  // Memoize metrics query options
  const metricsQueries = React.useMemo(
    () =>
      validatorData.map((validator) => ({
        ...validatorMetricsQueryOptions(
          validator.id,
          queryClient,
          {
            pools: validator.pools,
            totalAlgoStaked: validator.state.totalAlgoStaked,
            epochRoundLength: validator.config.epochRoundLength,
          },
          round,
        ),
        // Wait for the bulk read to settle, not to succeed: if it fails, metrics fall back to
        // reading each validator's own pools rather than never running at all.
        enabled: allValidatorsQuery.isSuccess && !poolGlobalStatesQuery.isPending,
      })),
    [
      validatorData,
      allValidatorsQuery.isSuccess,
      poolGlobalStatesQuery.isPending,
      queryClient,
      round,
    ],
  )

  // Nodely only describes today, so none of it is read at a past round. It is also the slowest
  // and least important read on the page (one request per pool), so it waits until the rest of
  // the page and its charts have loaded. Its APY only shows where there's no realised APY; until
  // either loads, the APY column shows the pools' on-chain moving average.
  const nodelyReady = extrasReady && !pinned
  const nodelyPerfQuery = useQuery({ ...nodelyPerfMetricsQueryOptions(), enabled: nodelyReady })

  // Metrics stay eager for every validator - the APY, rewards and status columns are all
  // sortable, and sorting on a column that only some rows have values for is broken sorting.
  // With the bulk pool state in the cache they cost no request, so they all run at once: metered,
  // they would trickle in over seconds and hold the history back behind them. Only when the bulk
  // read failed, and each validator reads its own pools, are they queued.
  const bulkPoolStates = poolGlobalStatesQuery.isSuccess
  const directMetrics = useQueries({
    queries: bulkPoolStates ? metricsQueries : [],
    combine: dataOf,
  })
  const fallbackMetricsQueries = React.useMemo(
    () => (bulkPoolStates ? [] : metricsQueries),
    [bulkPoolStates, metricsQueries],
  )
  const queuedMetricsQueries = useQueuedQueries(fallbackMetricsQueries, {
    host: 'algod',
    maxBatchSize: 6,
  })
  const metrics = bulkPoolStates ? directMetrics : queuedMetricsQueries.data

  // Nodely's realtime APY, one validator per batch slot, only on a node without time travel: with
  // it, the realised APY below takes its place. The list stays empty until the extras may start:
  // the queue releases on a timer, so queries handed to it disabled would all fire at once when
  // enabled.
  const timeTravelSupportQuery = useQuery(timeTravelSupportQueryOptions)
  const nodelyApyReady = nodelyReady && timeTravelSupportQuery.data?.supported === false
  const nodelyApyQueries = React.useMemo(
    () =>
      nodelyApyReady && !poolGlobalStatesQuery.isPending
        ? validatorData.map((validator) =>
            nodelyApyQueryOptions(validator.id, queryClient, validator.pools),
          )
        : [],
    [nodelyApyReady, poolGlobalStatesQuery.isPending, validatorData, queryClient],
  )
  // Nodely failures are swallowed by fetchNodelyVotingPerf, so there's no host to learn from
  const queuedNodelyApyQueries = useQueuedQueries(nodelyApyQueries, { maxBatchSize: 6 })

  // What stakers earned lately, the APY the table shows wherever the node can read past rounds:
  // the on-chain average swings day to day, and reads too high for validators paying out less
  // than daily (see realisedApyQueryOptions). Held back like Nodely's, but at any round. All at once, not queued: the SDK batches every pool's staker list at a round into one
  // query, so the whole table costs a few requests, and metering it would only spread them out.
  const realisedApyTargets = React.useMemo(
    () => (extrasReady && poolGlobalStatesQuery.isSuccess ? validatorData : []),
    [extrasReady, poolGlobalStatesQuery.isSuccess, validatorData],
  )
  const realisedApyQueries = React.useMemo(
    () =>
      realisedApyTargets.map((validator) =>
        realisedApyQueryOptions(
          validator.id,
          queryClient,
          { pools: validator.pools, epochRoundLength: validator.config.epochRoundLength },
          round,
        ),
      ),
    [realisedApyTargets, queryClient, round],
  )
  const realisedApyData = useQueries({ queries: realisedApyQueries, combine: dataOf })
  const realisedApyById = React.useMemo(
    () => new Map(realisedApyTargets.map((validator, i) => [validator.id, realisedApyData[i]])),
    [realisedApyTargets, realisedApyData],
  )

  // The last build, so the next one can keep the objects of validators nothing changed for
  const builtRef = React.useRef<AssembledValidators>(NO_VALIDATORS)

  const validators = React.useMemo(() => {
    const built = assembleValidators(
      validatorData,
      {
        rewardTokens: rewardTokenQueries.data,
        gatingAssets: gatingAssetQueries.data,
        nfds: nfdQueries.data,
        nfdAppIds,
        nfdPending: nfdQueries.pending,
        nfdSupportPending: nfdSupportQuery.isPending,
        perfRows: nodelyPerfQuery.data?.data,
        metrics,
        nodely: queuedNodelyApyQueries.data,
        realisedApyById,
        pinned,
      },
      builtRef.current,
    )
    // Safe to keep even from a render React later throws away: a build depends only on its inputs
    builtRef.current = built
    return built.list
  }, [
    validatorData,
    rewardTokenQueries.data,
    gatingAssetQueries.data,
    nfdQueries.data,
    nfdQueries.pending,
    nfdAppIds,
    nfdSupportQuery.isPending,
    nodelyPerfQuery.data,
    metrics,
    queuedNodelyApyQueries.data,
    realisedApyById,
    pinned,
  ])

  return {
    validators,
    isLoading: allValidatorsQuery.isLoading,
    error: allValidatorsQuery.error,
  }
}

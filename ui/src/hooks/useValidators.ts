import {
  useQueries,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  UseQueryResult,
} from '@tanstack/react-query'
import algosdk from 'algosdk'
import * as React from 'react'
import { createBaseValidator } from '@/api/contracts'
import {
  allValidatorsQueryOptions,
  assetQueryOptions,
  nfdQueryOptions,
  nodelyApyQueryOptions,
  nodelyPerfMetricsQueryOptions,
  hasLongEpoch,
  poolGlobalStatesQueryOptions,
  realisedApyQueryOptions,
  validatorMetricsQueryOptions,
} from '@/api/queries'
import { GatingType } from '@/constants/gating'
import { useAtRound } from '@/hooks/useAtRound'
import { useQueuedQueries } from '@/hooks/useQueuedQueries'
import { useExtrasReady } from '@/hooks/useExtrasReady'
import { Validator } from '@/interfaces/validator'
import { findValidatorPerf } from '@/utils/nodely'

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

  const nfdQueryOptionsList = React.useMemo(
    () => nfdAppIds.map((id) => nfdQueryOptions(id, { view: 'full' })),
    [nfdAppIds],
  )

  const rewardTokenQueries = useQueuedQueries(rewardTokenQueryOptions, { host: 'algod' })
  const gatingAssetQueries = useQueuedQueries(gatingAssetQueryOptions, { host: 'algod' })
  const nfdQueries = useQueuedQueries(nfdQueryOptionsList, { host: 'nfd' })

  // Every pool's lastPayout in one request, shared by all the metrics queries below
  const poolGlobalStatesQuery = useQuery(poolGlobalStatesQueryOptions(queryClient, round))

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
  // the page and its charts have loaded; until then the APY column shows the pools' on-chain
  // moving average.
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

  // Nodely's realtime APY, one validator per batch slot. The list stays empty until the extras
  // may start: the queue releases on a timer, so queries handed to it disabled would all fire
  // at once when enabled.
  const nodelyApyQueries = React.useMemo(
    () =>
      nodelyReady && !poolGlobalStatesQuery.isPending
        ? validatorData.map((validator) =>
            nodelyApyQueryOptions(validator.id, queryClient, validator.pools),
          )
        : [],
    [nodelyReady, poolGlobalStatesQuery.isPending, validatorData, queryClient],
  )
  // Nodely failures are swallowed by fetchNodelyVotingPerf, so there's no host to learn from
  const queuedNodelyApyQueries = useQueuedQueries(nodelyApyQueries, { maxBatchSize: 6 })

  // What stakers earned lately, for the few validators paying out less than daily: their
  // on-chain average reads too high (see realisedApyQueryOptions). Held back like Nodely's, but
  // at any round: past rounds have nothing better.
  const realisedApyTargets = React.useMemo(
    () =>
      extrasReady && poolGlobalStatesQuery.isSuccess
        ? validatorData.filter((validator) =>
            hasLongEpoch(
              validator.pools,
              validator.config.epochRoundLength,
              poolGlobalStatesQuery.data,
            ),
          )
        : [],
    [extrasReady, poolGlobalStatesQuery.isSuccess, poolGlobalStatesQuery.data, validatorData],
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
  const queuedRealisedApyQueries = useQueuedQueries(realisedApyQueries, {
    host: 'algod',
    maxBatchSize: 3,
  })
  const realisedApyById = React.useMemo(
    () =>
      new Map(
        realisedApyTargets.map((validator, i) => [validator.id, queuedRealisedApyQueries.data[i]]),
      ),
    [realisedApyTargets, queuedRealisedApyQueries.data],
  )

  // Combine all data synchronously
  const validators = React.useMemo(() => {
    const result: Validator[] = []

    for (let i = 0; i < validatorData.length; i++) {
      const { id, config, state, pools, nodePoolAssignment } = validatorData[i]

      // Create base validator
      const baseValidator = createBaseValidator({
        id,
        config,
        state,
        pools,
        nodePoolAssignment,
      })

      // Add enrichment data if available
      if (baseValidator.config.rewardTokenId > 0) {
        const rewardToken = rewardTokenQueries.data.find(
          (asset) => asset?.index === baseValidator.config.rewardTokenId,
        )
        if (rewardToken) {
          baseValidator.rewardToken = rewardToken
        }
      }

      if (baseValidator.config.entryGatingType === GatingType.AssetId) {
        baseValidator.gatingAssets = baseValidator.config.entryGatingAssets
          .map((assetId) => gatingAssetQueries.data.find((asset) => asset?.index === assetId))
          .filter(Boolean) as algosdk.modelsv2.Asset[]
      }

      if (baseValidator.config.nfdForInfo > 0) {
        const nfd = nfdQueries.data.find(
          (result) => result?.appID === Number(baseValidator.config.nfdForInfo),
        )
        if (nfd) {
          baseValidator.nfd = nfd
        }
      }
      baseValidator.perf = pinned
        ? undefined
        : findValidatorPerf(nodelyPerfQuery.data?.data, baseValidator.id)

      // Add metrics if available
      const validatorMetrics = metrics[i]
      if (validatorMetrics) {
        const nodely = queuedNodelyApyQueries.data[i]
        baseValidator.rewardsBalance = validatorMetrics.rewardsBalance
        baseValidator.roundsSinceLastPayout = validatorMetrics.roundsSinceLastPayout
        baseValidator.apy = nodely?.apy ?? realisedApyById.get(id) ?? validatorMetrics.apy
        baseValidator.extDeposits = nodely?.extDeposits ?? validatorMetrics.extDeposits
      }

      result.push(baseValidator)
    }

    return result
  }, [
    validatorData,
    rewardTokenQueries.data,
    gatingAssetQueries.data,
    nfdQueries.data,
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

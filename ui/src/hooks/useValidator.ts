import {
  skipToken,
  useQueries,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from '@tanstack/react-query'
import algosdk from 'algosdk'
import * as React from 'react'
import { createBaseValidator, ValidatorNotFoundError } from '@/api/contracts'
import {
  assetQueryOptions,
  nfdQueryOptions,
  nodelyApyQueryOptions,
  realisedApyQueryOptions,
  validatorConfigQueryOptions,
  validatorMetricsQueryOptions,
  validatorNodePoolAssignmentsQueryOptions,
  validatorPoolStatesQueryOptions,
  validatorPoolsQueryOptions,
  validatorStateQueryOptions,
} from '@/api/queries'
import { GatingType } from '@/constants/gating'
import { useAtRound } from '@/hooks/useAtRound'
import { useExtrasReady } from '@/hooks/useExtrasReady'
import { Validator } from '@/interfaces/validator'
import { keepAcrossRounds, retryUnlessRoundUnavailable } from '@/utils/round'

export interface ValidatorView {
  /** Undefined until the validator's first round loads */
  validator?: Validator
  /** The validator on screen is from the previous round, while the round asked for loads */
  refreshing: boolean
  /** Why the round asked for couldn't load: say, the validator didn't exist yet */
  error: Error | null
  /** The validator has an NFD that hasn't loaded yet, so its name isn't known */
  nfdPending: boolean
}

/** Not found is an answer, not a failure: don't retry it. */
const retryUnlessNotFound = (failureCount: number, error: Error) =>
  !(error instanceof ValidatorNotFoundError) && retryUnlessRoundUnavailable(failureCount, error)

function combineAssets(results: UseQueryResult<algosdk.modelsv2.Asset>[]) {
  return {
    assets: results.flatMap((result) => (result.data ? [result.data] : [])),
    refreshing: results.some((result) => result.isPlaceholderData),
  }
}

/** A core read that keeps the previous round on screen while it loads another. */
function keepCore<O extends { queryKey: readonly unknown[] }>(options: O): O {
  return { ...keepAcrossRounds(options), retry: retryUnlessNotFound }
}

/**
 * Fetches validator data and enrichment data in parallel. Moving to another round keeps the
 * previous round's validator on screen (`refreshing`) until the new one loads, rather than
 * suspending the page.
 */
export function useValidator(validatorId: number): ValidatorView {
  const queryClient = useQueryClient()
  const { round, pinned } = useAtRound()
  const extrasReady = useExtrasReady()

  // Core validator queries, all from one read (`fetchValidatorCoreData` shares it)
  const configQuery = useQuery(keepCore(validatorConfigQueryOptions(validatorId, round)))
  const stateQuery = useQuery(keepCore(validatorStateQueryOptions(validatorId, round)))
  const poolsQuery = useQuery(keepCore(validatorPoolsQueryOptions(validatorId, round)))
  const nodePoolAssignmentQuery = useQuery(
    keepCore(validatorNodePoolAssignmentsQueryOptions(validatorId, round)),
  )
  const coreQueries = [configQuery, stateQuery, poolsQuery, nodePoolAssignmentQuery]
  const coreFresh = coreQueries.every((query) => query.isSuccess && !query.isPlaceholderData)

  // This validator's pools' state (not every pool's, as the dashboard reads). The metrics queryFn
  // below reads it back out of the cache, so metrics wait for it instead of reading it again.
  const poolsFresh = poolsQuery.isSuccess && !poolsQuery.isPlaceholderData
  const poolGlobalStatesQuery = useQuery(
    keepAcrossRounds({
      ...validatorPoolStatesQueryOptions(queryClient, validatorId, poolsQuery.data ?? [], round),
      enabled: poolsFresh,
    }),
  )
  const poolGlobalStatesSettled =
    (poolGlobalStatesQuery.isSuccess || poolGlobalStatesQuery.isError) &&
    !poolGlobalStatesQuery.isPlaceholderData

  // Metrics take their inputs explicitly, so they only run on this round's inputs. Until then
  // the previous round's metrics stay on screen.
  const metricsOptions = validatorMetricsQueryOptions(
    validatorId,
    queryClient,
    {
      pools: poolsQuery.data ?? [],
      totalAlgoStaked: stateQuery.data?.totalAlgoStaked ?? 0n,
      epochRoundLength: configQuery.data?.epochRoundLength ?? 0,
    },
    round,
  )
  const metricsQuery = useQuery(
    keepAcrossRounds({
      ...metricsOptions,
      queryFn: coreFresh && poolGlobalStatesSettled ? metricsOptions.queryFn : skipToken,
    }),
  )

  // Nodely's realtime APY: only now, and only once the rest of the page and its charts have loaded.
  // Shown where there's no realised APY; until either loads, the APY is the pools' on-chain moving
  // average, from the metrics above.
  const nodelyApyQuery = useQuery({
    ...nodelyApyQueryOptions(validatorId, queryClient, poolsQuery.data ?? []),
    enabled: extrasReady && !pinned && coreFresh,
  })

  // The APY stakers actually earned lately, which the page shows wherever it can: the on-chain
  // average swings day to day, and reads too high for validators paying out less than daily. A
  // few reads, once the rest of the page and its charts have loaded. Not kept across rounds: until
  // it loads, the metrics' corrected average stands in.
  const epochRoundLength = configQuery.data?.epochRoundLength ?? 0
  const realisedApyQuery = useQuery({
    ...realisedApyQueryOptions(
      validatorId,
      queryClient,
      { pools: poolsQuery.data ?? [], epochRoundLength },
      round,
    ),
    enabled: extrasReady && coreFresh && poolGlobalStatesSettled && !!poolsQuery.data,
  })

  // Reward token query
  const rewardTokenQuery = useQuery({
    ...assetQueryOptions(Number(configQuery.data?.rewardTokenId), round, queryClient),
    enabled: Boolean(configQuery.data?.rewardTokenId && configQuery.data.rewardTokenId > 0n),
  })

  // Gating asset queries, any round's copy standing in while one loads (see assetQueryOptions).
  // Combined, so the result only changes when an asset does.
  const gatingAssets = useQueries({
    queries:
      configQuery.data?.entryGatingType === GatingType.AssetId
        ? configQuery.data.entryGatingAssets
            .filter((id): id is bigint => id > 0n)
            .map((id) => assetQueryOptions(Number(id), round, queryClient))
        : [],
    combine: combineAssets,
  })

  // NFD query, as of the round where the read node supports it (see `@/api/nfd`)
  const nfdForInfo = Number(configQuery.data?.nfdForInfo ?? 0)
  const nfdQuery = useQuery({
    ...nfdQueryOptions(nfdForInfo, { view: 'full' }, {}, round),
    enabled: nfdForInfo > 0,
  })

  const refreshing =
    coreQueries.some((query) => query.isPlaceholderData) ||
    metricsQuery.isPlaceholderData ||
    rewardTokenQuery.isPlaceholderData ||
    gatingAssets.refreshing
  const error = coreQueries.find((query) => query.isError)?.error ?? null

  // Combine all data synchronously
  const validator = React.useMemo((): Validator | undefined => {
    if (!configQuery.data || !stateQuery.data || !poolsQuery.data || !nodePoolAssignmentQuery.data)
      return undefined

    // Create base validator
    const baseValidator = createBaseValidator({
      id: validatorId,
      config: configQuery.data,
      state: stateQuery.data,
      pools: poolsQuery.data,
      nodePoolAssignment: nodePoolAssignmentQuery.data,
    })

    // Add enrichment data
    if (rewardTokenQuery.data) {
      baseValidator.rewardToken = rewardTokenQuery.data
    }

    if (baseValidator.config.entryGatingType === GatingType.AssetId) {
      baseValidator.gatingAssets = gatingAssets.assets
    }

    if (nfdForInfo > 0 && nfdQuery.data) {
      baseValidator.nfd = nfdQuery.data
    }

    // Add metrics
    if (metricsQuery.data) {
      baseValidator.rewardsBalance = metricsQuery.data.rewardsBalance
      baseValidator.roundsSinceLastPayout = metricsQuery.data.roundsSinceLastPayout
      const nodely = pinned ? undefined : nodelyApyQuery.data
      baseValidator.apy = realisedApyQuery.data ?? nodely?.apy ?? metricsQuery.data.apy
      baseValidator.extDeposits = nodely?.extDeposits ?? metricsQuery.data.extDeposits
    }

    return baseValidator
  }, [
    validatorId,
    configQuery.data,
    stateQuery.data,
    poolsQuery.data,
    nodePoolAssignmentQuery.data,
    rewardTokenQuery.data,
    gatingAssets.assets,
    nfdForInfo,
    nfdQuery.data,
    metricsQuery.data,
    nodelyApyQuery.data,
    realisedApyQuery.data,
    pinned,
  ])

  return {
    validator,
    refreshing,
    error,
    nfdPending: nfdForInfo > 0 && nfdQuery.isPending,
  }
}

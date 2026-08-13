import {
  assetsQueryOptions,
  nfdQueryOptions,
  nodelyPerfMetricsQueryOptions,
  numValidatorsQueryOptions,
  poolBalancesAndLastPayoutsQueryOptions,
  validatorSingleMetricsQueryOptions,
  validatorsQueryOptions,
} from '@/api/queries'
import { GatingType } from '@/constants/gating'
import { Asset } from '@/interfaces/asset'
import { Validator } from '@/interfaces/validator'
import { unique } from '@/utils/tests/utils'
import { useQueries, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import * as React from 'react'
import { useQueuedQueries } from './useQueuedQueries'

/**
 * Fetches all validator data and enrichment data in parallel.
 */
export function useValidators(): {
  validators: Validator[]
  isLoading: boolean
  error: Error | undefined | null
  dataUpdatedAt: number
} {
  const queryClient = useQueryClient()

  // Get total number of validators
  const numValidatorsQuery = useSuspenseQuery(numValidatorsQueryOptions)
  const numValidators = numValidatorsQuery.data

  const validatorIds = React.useMemo(() => {
    return Array.from({ length: numValidators }, (_, i) => i + 1)
  }, [numValidators])

  // Memoize query options
  const validatorQueryOptionsMemo = React.useMemo(
    () => validatorsQueryOptions(validatorIds, queryClient),
    [validatorIds],
  )

  const validatorsQuery = useQuery(validatorQueryOptionsMemo)

  // Memoize metrics query options
  // sort validators by their total algo staked descending, which is the default sort
  const poolAppIds = React.useMemo(
    () => validatorsQuery.data?.flatMap(({ pools }) => pools.map((pool) => pool.poolAppId)) ?? [],
    [validatorIds, validatorsQuery.data],
  )

  const poolBalancesQueryOpts = React.useMemo(
    () => poolBalancesAndLastPayoutsQueryOptions(poolAppIds, queryClient),
    [poolAppIds, queryClient],
  )

  const poolBalancesQuery = useQuery(poolBalancesQueryOpts)

  // Memoize metrics query options
  // sort validators by their total algo staked descending, which is the default sort
  const metricsQueries = React.useMemo(
    () =>
      poolBalancesQuery.data && validatorsQuery.data
        ? validatorsQuery.data
            .map((validator) => ({ ...validator })) // copy to avoid mutating original data unnecessarily
            .sort(({ state: { totalAlgoStaked: a } }, { state: { totalAlgoStaked: b } }) =>
              a > b ? -1 : 1,
            )
            .map(({ id }) => ({
              ...validatorSingleMetricsQueryOptions(id, queryClient),
            }))
        : [],
    [validatorIds, validatorsQuery.data, poolBalancesQuery.data],
  )

  // Use queued queries for metrics. 8 in flight at any time
  const queuedMetricsQueries = useQueuedQueries(metricsQueries, 8)

  // nodely performance data
  const nodelyPerfQuery = useQuery(nodelyPerfMetricsQueryOptions())

  // look up all assets with simulate
  const assetIds = React.useMemo(() => {
    const rewardAssetIds =
      validatorsQuery.data
        ?.map((q) => q.config.rewardTokenId)
        .filter((id): id is bigint => id !== undefined && id > 0n) ?? []

    const gatingAssetIds =
      validatorsQuery.data?.flatMap((q) =>
        q.config.entryGatingType === GatingType.AssetId
          ? q.config.entryGatingAssets.filter((id): id is bigint => id > 0n)
          : [],
      ) ?? []

    return unique([...rewardAssetIds, ...gatingAssetIds])
  }, [validatorsQuery.data])

  const assetQuery = useQuery(assetsQueryOptions(assetIds))

  const nfdQueries = useQueries({
    queries: poolBalancesQuery.data // delay NFD queries until pools data is loaded. NFD lookups starve available connection threads
      ? validatorsQuery
          .data!.map((q) => Number(q.config.nfdForInfo))
          .filter((id) => id > 0)
          .map((id) => nfdQueryOptions(id, { view: 'full' }))
      : [],
  })

  // Combine all data synchronously
  const validators = React.useMemo(() => {
    if (!validatorsQuery.data) return []

    return validatorsQuery.data.map((baseValidator) => {
      let validator = baseValidator
      const validatorId = baseValidator.id

      const metrics = queryClient.getQueryData(
        validatorSingleMetricsQueryOptions(validatorId, queryClient).queryKey,
      )

      if (validator.config.rewardTokenId > 0) {
        const rewardToken = assetQuery.data?.find((q) => q.index === validator.config.rewardTokenId)
        if (rewardToken) validator = { ...validator, rewardToken }
      }

      if (validator.config.entryGatingType === GatingType.AssetId) {
        const gatingAssets = validator.config.entryGatingAssets
          .map((assetId) => assetQuery.data?.find((q) => q.index === assetId))
          .filter(Boolean) as Asset[]
        if (gatingAssets.length > 0) validator = { ...validator, gatingAssets }
      }

      if (validator.config.nfdForInfo > 0) {
        const nfd = nfdQueries.find(
          (q) => q.data?.appID === Number(validator.config.nfdForInfo),
        )?.data
        if (nfd) validator = { ...validator, nfd }
      }

      if (nodelyPerfQuery.data?.data) {
        const perf = nodelyPerfQuery.data.data.find(
          (q) => q.validatorid === validator.id.toString(),
        )?.perf
        if (perf !== undefined) validator = { ...validator, perf }
      }

      if (metrics) {
        validator = {
          ...validator,
          rewardsBalance: metrics.rewardsBalance,
          roundsSinceLastPayout: metrics.roundsSinceLastPayout,
          apy: metrics.apy,
          extDeposits: metrics.extDeposits,
        }
      }

      return validator
    })
  }, [
    validatorIds,
    validatorsQuery.data,
    assetQuery.data,
    nfdQueries,
    nodelyPerfQuery.data,
    queuedMetricsQueries.data,
  ])

  const { isLoading, error, dataUpdatedAt } = validatorsQuery

  return { validators, isLoading, error, dataUpdatedAt }
}

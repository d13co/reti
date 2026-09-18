import { convertPoolTolocalPoolInfo, createBaseValidator } from '@/api/contracts'
import { assetsQueryOptions, nfdQueryOptions, validatorSingleQueryOptions } from '@/api/queries'
import { GatingType } from '@/constants/gating'
import { Asset } from '@/interfaces/asset'
import { Validator } from '@/interfaces/validator'
import { useSuspenseQueries, useSuspenseQuery } from '@tanstack/react-query'
import * as React from 'react'

/**
 * Fetches validator data and enrichment data in parallel.
 * Metrics (APY, rewards) are intentionally not fetched here — they depend on a
 * sometimes-unreliable Nodely APY endpoint and must not block page rendering.
 * Components that need them query validatorSingleMetricsQueryOptions directly.
 */
export function useValidator(validatorId: number): Validator | undefined {
  // Core validator query
  const validatorQuery = useSuspenseQuery(validatorSingleQueryOptions(validatorId))

  const config = validatorQuery.data?.config

  const assetIds = React.useMemo(() => {
    return [
      validatorQuery.data?.config.rewardTokenId,
      ...validatorQuery.data?.config.entryGatingAssets,
    ].filter((v) => !!v && v > 0n)
  }, [validatorQuery.data])

  const assetQuery = useSuspenseQuery(assetsQueryOptions(assetIds))

  // NFD query
  const [nfdQuery] = useSuspenseQueries({
    queries: [
      ...(config?.nfdForInfo && config.nfdForInfo > 0
        ? [nfdQueryOptions(Number(config.nfdForInfo), { view: 'full' })]
        : []),
    ],
  })

  // Combine all data synchronously
  const validator = React.useMemo((): Validator | undefined => {
    if (!validatorQuery.data) return undefined

    const { config, nodeAssignment: nodePoolAssignment, pools, state } = validatorQuery.data

    // Create base validator
    const baseValidator = createBaseValidator({
      id: validatorId,
      config,
      state,
      nodePoolAssignment,
      pools: pools.map((poolInfo, index) => {
        return convertPoolTolocalPoolInfo(poolInfo, index + 1)
      }),
    })

    // Add enrichment data
    if (config.rewardTokenId) {
      baseValidator.rewardToken = assetQuery.data?.find(
        ({ index }) => index === config.rewardTokenId,
      )
    }

    if (baseValidator.config.entryGatingType === GatingType.AssetId) {
      const gatingAssets = config.entryGatingAssets
        .filter((assetId) => !!assetId)
        .map((assetId) => assetQuery.data.find((asset) => asset.index === assetId))
        .filter((e) => e !== undefined) as Asset[]
      baseValidator.gatingAssets = gatingAssets?.length > 0 ? gatingAssets : undefined
    }

    if (nfdQuery?.data) {
      baseValidator.nfd = nfdQuery.data
    }

    return baseValidator
  }, [validatorId, validatorQuery.data, nfdQuery?.data, assetQuery.data])

  return validator
}

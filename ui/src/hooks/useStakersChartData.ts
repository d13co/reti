import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import {
  nfdLookupQueryOptions,
  stakedInfoQueryOptions,
  validatorPoolsQueryOptions,
} from '@/api/queries'
import { StakedInfo } from '@/contracts/StakingPoolClient'
import { useAtRound } from '@/hooks/useAtRound'
import { LocalPoolInfo } from '@/interfaces/validator'
import { keepAcrossRounds } from '@/utils/round'

interface UseChartDataProps {
  selectedPool: string
  validatorId: number
  pauseRefetch?: boolean // Pause refetching while adding a pool
}

export function useStakersChartData({
  selectedPool,
  validatorId,
  pauseRefetch = false,
}: UseChartDataProps) {
  const queryClient = useQueryClient()
  const { round } = useAtRound()

  // Moving to another round keeps the previous round's pools and stakers on screen until it loads
  const poolsInfoQuery = useQuery(
    keepAcrossRounds({
      ...validatorPoolsQueryOptions(validatorId, round),
      enabled: !pauseRefetch,
    }),
  )
  const poolsInfo = poolsInfoQuery.data || []

  // useQueries matches its queries by key, so it can't carry a pool's stakers over to another
  // round by itself: they come from the cache at the round last shown in full instead
  const shownRound = React.useRef(round)
  const allStakedInfo = useQueries({
    queries: poolsInfo.map((pool) => ({
      ...stakedInfoQueryOptions(pool.poolAppId, round),
      enabled: !pauseRefetch,
      placeholderData: () =>
        queryClient.getQueryData(
          stakedInfoQueryOptions(pool.poolAppId, shownRound.current).queryKey,
        ),
    })),
  })
  const loaded =
    poolsInfoQuery.isSuccess &&
    !poolsInfoQuery.isPlaceholderData &&
    allStakedInfo.every((query) => query.isSuccess && !query.isPlaceholderData)
  React.useEffect(() => {
    if (loaded) shownRound.current = round
  }, [loaded, round])

  // Function to invalidate/refetch pools and staked info queries. Only called after a write, so
  // only ever needed live.
  const refetchAll = React.useCallback(async () => {
    const poolsQuery = validatorPoolsQueryOptions(validatorId)
    await queryClient.invalidateQueries({ queryKey: poolsQuery.queryKey })
    // Wait for pools query to settle before refetching staked info
    const pools: LocalPoolInfo[] = await queryClient.fetchQuery(poolsQuery)
    if (pools) {
      await Promise.all(
        pools.map((pool) =>
          queryClient.invalidateQueries({
            queryKey: stakedInfoQueryOptions(pool.poolAppId).queryKey,
          }),
        ),
      )
    }
  }, [queryClient, validatorId])

  const isLoading = poolsInfoQuery.isLoading || allStakedInfo.some((query) => query.isLoading)
  const isSuccess = poolsInfoQuery.isSuccess && allStakedInfo.every((query) => query.isSuccess)
  // Showing the previous round's pools or stakers while this round's load
  const refreshing =
    poolsInfoQuery.isPlaceholderData || allStakedInfo.some((query) => query.isPlaceholderData)
  const isError = poolsInfoQuery.isError || allStakedInfo.some((query) => query.isError)

  const defaultMessage = isError ? 'An error occurred while loading staking data.' : undefined

  const errorMessage =
    poolsInfoQuery.error?.message ||
    allStakedInfo.find((query) => query.error)?.error?.message ||
    defaultMessage

  const stakerAddresses = React.useMemo(() => {
    if (!allStakedInfo) return []

    const addresses = new Set<string>()

    allStakedInfo.forEach((query, i) => {
      if (selectedPool !== 'all' && Number(selectedPool) !== i) return

      const stakers = query.data || []
      stakers.forEach((staker) => addresses.add(staker.account))
    })

    return Array.from(addresses)
  }, [allStakedInfo, selectedPool])

  // As of the round where the read node supports it; the round last shown in full stands in
  const nfdQueries = useQueries({
    queries: stakerAddresses.map((address) => ({
      ...nfdLookupQueryOptions(address, round),
      placeholderData: () =>
        queryClient.getQueryData(nfdLookupQueryOptions(address, shownRound.current).queryKey),
    })),
  })

  const stakersChartData = React.useMemo(() => {
    if (!allStakedInfo) return []

    const stakerTotals: Record<string, StakedInfo> = {}
    const nfdMap = new Map(
      nfdQueries.map((query, index) => [stakerAddresses[index], query.data?.name]),
    )

    allStakedInfo.forEach((query, i) => {
      if (selectedPool !== 'all' && Number(selectedPool) !== i) return

      const stakers = query.data || []

      stakers.forEach((staker) => {
        const id = staker.account

        if (!stakerTotals[id]) {
          stakerTotals[id] = {
            ...staker,
            balance: BigInt(0),
            totalRewarded: BigInt(0),
            rewardTokenBalance: BigInt(0),
          }
        }
        stakerTotals[id].balance += staker.balance
        stakerTotals[id].totalRewarded += staker.totalRewarded
        stakerTotals[id].rewardTokenBalance += staker.rewardTokenBalance
      })
    })

    return Object.values(stakerTotals).map((staker) => {
      const nfdName = nfdMap.get(staker.account)
      return {
        name: nfdName || staker.account,
        value: Number(staker.balance),
        address: staker.account,
        // The real URL, so a new tab (middle or ctrl click) opens it at the same round; a plain
        // click is routed in the app by `StakersList`
        href: `/history/${staker.account}${round === undefined ? '' : `?round=${round}`}`,
        target: '_self',
      }
    })
  }, [allStakedInfo, selectedPool, nfdQueries, stakerAddresses, round])

  return {
    stakersChartData,
    poolsInfo,
    isLoading,
    refreshing,
    isError,
    errorMessage,
    isSuccess,
    refetchAll,
  }
}

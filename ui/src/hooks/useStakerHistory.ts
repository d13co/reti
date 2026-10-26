import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  stakerHistoryQueryOptions,
  stakerPoolsQueryOptions,
  type StakerHistoryData,
} from '@/api/history'
import { timeTravelSupportQueryOptions } from '@/api/reti'
import { useAtRound } from '@/hooks/useAtRound'
import { keepAcrossRounds } from '@/utils/round'

/**
 * The staking history of `address` up to the round on screen, across every validator or only
 * `validatorId`'s. It needs a node with time travel: `supported` is false (and nothing is read)
 * without one, and undefined until the node has said. The data fills in as it loads (see
 * `StakerHistoryData.complete`), and moving to another round keeps the previous round's history on
 * screen until the new one starts arriving.
 */
export function useStakerHistory(address: string | null | undefined, validatorId?: number) {
  const queryClient = useQueryClient()
  const { round } = useAtRound()
  const supportQuery = useQuery(timeTravelSupportQueryOptions)
  const supported = supportQuery.data?.supported
  const query = useQuery<StakerHistoryData>({
    ...keepAcrossRounds(stakerHistoryQueryOptions(queryClient, address ?? '', round, validatorId)),
    enabled: !!address && !!supported,
  })
  return { query, supported }
}

/** Every pool `address` was ever in, up to the round on screen; gated like `useStakerHistory`. */
export function useStakerPools(address: string | null | undefined) {
  const { round } = useAtRound()
  const supportQuery = useQuery(timeTravelSupportQueryOptions)
  return useQuery({
    ...keepAcrossRounds(stakerPoolsQueryOptions(address ?? '', round)),
    enabled: !!address && !!supportQuery.data?.supported,
  })
}

import { queryOptions, useQuery } from '@tanstack/react-query'
import { useAtRound } from '@/hooks/useAtRound'
import { useBlockTime } from '@/hooks/useBlockTime'
import { Validator } from '@/interfaces/validator'
import { fetchRewardTokenHolding, remainingRewardsBalance } from '@/utils/contracts'
import { keepAcrossRounds, roundKey, roundQueryDefaults } from '@/utils/round'

/**
 * The reward tokens a validator has left to pay out, as of the round shown.
 *
 * Only pool 1's balance is read and cached; what's owed to stakers is taken off it from the
 * validator passed in, so the two always come from the same round. `refreshing` (the validator is
 * the previous round's, while this one loads) holds the read back until the validator is this
 * round's: its pools may differ.
 */
export function useRewardBalance(validator: Validator, refreshing = false) {
  const { rewardTokenId } = validator.config
  const { rewardTokenHeldBack } = validator.state
  const poolAppId = validator.pools[0]?.poolAppId ?? 0n
  const { round } = useAtRound()

  const blockTime = useBlockTime()
  const staleTime = Number(validator.config.epochRoundLength) * blockTime.ms

  // Moving to another round keeps the previous round's balance on screen until it loads
  return useQuery({
    ...keepAcrossRounds(
      queryOptions({
        queryKey: [
          'reward-balance',
          validator.id,
          String(poolAppId),
          String(rewardTokenId),
          roundKey(round),
        ],
        queryFn: () => fetchRewardTokenHolding(poolAppId, rewardTokenId, round),
        retry: (retryCount, error) => {
          if (error?.message.includes('Pool 1 not found')) {
            return false
          }
          return retryCount < 3
        },
        enabled: !!rewardTokenId && !refreshing,
        ...roundQueryDefaults(round, { staleTime }),
      }),
    ),
    select: (holding: bigint) => remainingRewardsBalance(holding, rewardTokenHeldBack),
  })
}

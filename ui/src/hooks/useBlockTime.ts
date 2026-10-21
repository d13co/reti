import { useQuery } from '@tanstack/react-query'
import { blockTimeQueryOptions } from '@/api/queries'
import { useAtRound } from '@/hooks/useAtRound'
import { calculateAverageBlockTime } from '@/utils/blocks'
import { formatAmount } from '@/utils/format'

export interface BlockTime {
  ms: number
  secs: number
}

/** The average block time over the 10 blocks before the round being shown. */
export function useBlockTime(): BlockTime {
  const { round } = useAtRound()
  const { data: timestamps = [] } = useQuery(blockTimeQueryOptions(round))
  const ms = calculateAverageBlockTime(timestamps)
  const secs = ms ? Number(formatAmount(ms / 1000, { precision: 1, trim: true })) : 0

  return { ms, secs }
}

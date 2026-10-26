import { useQuery } from '@tanstack/react-query'
import { balanceQueryOptions, historicalBalanceQueryOptions } from '@/api/queries'
import { AlgoDisplayAmount } from '@/components/AlgoDisplayAmount'
import { useAtRound, useViewedTime } from '@/hooks/useAtRound'
import { dayjs } from '@/utils/dayjs'

interface WalletBalanceProps {
  activeAddress: string
}

/** The account's balance: live, or as of the round on screen while time travelling. */
export function WalletBalance({ activeAddress }: WalletBalanceProps) {
  const { round } = useAtRound()
  const viewedTime = useViewedTime()
  const liveQuery = useQuery({
    ...balanceQueryOptions(activeAddress),
    enabled: round === undefined,
  })
  const historicalQuery = useQuery({
    ...historicalBalanceQueryOptions(activeAddress, round ?? 0n),
    enabled: round !== undefined,
  })
  const { data: balance, isLoading, error } = round === undefined ? liveQuery : historicalQuery

  if (isLoading) {
    return <span className="text-sm">Loading...</span>
  }

  if (error || !balance) {
    return <span className="text-sm text-red-500">Error fetching balance</span>
  }

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium leading-none">
        {round === undefined ? 'Account Balance' : 'Historical Balance'}
      </p>
      <p className="text-base font-mono">
        <AlgoDisplayAmount
          amount={balance.available.algos}
          mutedRemainder
          symbolClassName="text-muted-foreground"
          sizePercent={75}
        />
      </p>
      {round !== undefined && (
        <p className="text-xs text-muted-foreground">
          {viewedTime !== undefined
            ? `As of ${dayjs.unix(viewedTime).format('lll')}`
            : `As of round ${round.toLocaleString()}`}
        </p>
      )}
    </div>
  )
}

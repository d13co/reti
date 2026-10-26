import { useQuery } from '@tanstack/react-query'
import { useWallet } from '@txnlab/use-wallet-react'
import { stakesQueryOptions } from '@/api/queries'
import { useAtRound } from '@/hooks/useAtRound'

/**
 * Whether the page's other reads may start: the connected account's own stakes go first, then
 * everything else (history charts, the validator table's pool states and metrics). True without
 * a wallet, once the stakes have loaded or failed, and when nothing is reading them (a page that
 * doesn't show them). It watches the stakes read without starting it: the routes that show the
 * stakes start it first thing (see the dashboard's and the validator page's route hooks).
 */
export function useOwnStakesFirst(): boolean {
  const { activeAddress } = useWallet()
  const { round } = useAtRound()
  const { status, fetchStatus } = useQuery({
    ...stakesQueryOptions(activeAddress, round),
    enabled: false,
  })
  return !activeAddress || status !== 'pending' || fetchStatus === 'idle'
}

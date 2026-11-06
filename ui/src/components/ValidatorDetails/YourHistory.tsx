import { Link } from '@tanstack/react-router'
import { useWallet } from '@txnlab/use-wallet-react'
import { ReadFailure } from '@/components/ReadFailure'
import { RefreshOverlay } from '@/components/RefreshOverlay'
import { StakeHistoryNote, StakeHistoryTable } from '@/components/StakeHistory/StakeHistoryTable'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Loading } from '@/components/Loading'
import { useStakerHistory } from '@/hooks/useStakerHistory'
import { Validator } from '@/interfaces/validator'

/** Rows the card shows; the full history is a link away. */
const MAX_ROWS = 10

/** Skeleton rows while the first events load, and under them while more may arrive. */
const LOADING_ROWS = { first: 3, more: 1 }

interface YourHistoryProps {
  validator: Validator
}

/**
 * The connected account's deposits into and withdrawals from this validator, up to the round on
 * screen. Uses the wallet's address rather than the write address, so it still shows while time
 * travelling. Hidden without a wallet, on a node without time travel, and for an account that has
 * never staked with this validator; it appears once its pools are known, then fills in.
 */
export function YourHistory({ validator }: YourHistoryProps) {
  const { activeAddress } = useWallet()
  const { query, supported } = useStakerHistory(activeAddress, validator.id)
  const history = query.data

  if (!activeAddress || !supported || !history || history.pools.length === 0) return null
  if (history.complete && history.events.length === 0) return null

  const loadingRows = history.complete
    ? 0
    : history.events.length === 0
      ? LOADING_ROWS.first
      : LOADING_ROWS.more

  return (
    <Card className="relative" aria-busy={query.isPlaceholderData}>
      <CardHeader>
        <div className="flex items-center justify-between gap-x-2">
          <CardTitle as="h2" className="flex items-center gap-x-2">
            Your History
            {!history.complete && !query.isError && <Loading size="sm" inline />}
          </CardTitle>
          <Link
            to="/history/$address"
            params={{ address: activeAddress }}
            className="link text-sm underline-offset-4"
          >
            See all
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isError && (
          <ReadFailure title="Couldn't load the whole history" error={query.error} />
        )}
        <StakeHistoryTable
          events={history.events.slice(0, MAX_ROWS)}
          compact
          loadingRows={query.isError ? 0 : loadingRows}
        />
        <StakeHistoryNote />
      </CardContent>
      <RefreshOverlay active={query.isPlaceholderData} />
    </Card>
  )
}

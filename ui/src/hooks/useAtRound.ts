import { useSearch } from '@tanstack/react-router'
import { useWallet } from '@txnlab/use-wallet-react'
import * as React from 'react'
import { getViewedTime, subscribeViewedTime } from '@/utils/contracts'
import { parseRound } from '@/utils/round'

export interface AtRound {
  /** The round every protocol read is pinned to, or undefined for the latest state. */
  round?: bigint
  /** Whether the app is time travelling: showing a past round, read-only. */
  pinned: boolean
}

/**
 * The round the app is showing, from the root route's `?round=` search param. Every hook and
 * route that builds protocol query options passes `round` through, so the whole page reads as of
 * the same round.
 */
export function useAtRound(): AtRound {
  // Only the round: a change to any other search param doesn't re-render every caller
  const round = parseRound(
    useSearch({ strict: false, select: (search) => (search as { round?: unknown }).round }),
  )
  return { round, pinned: round !== undefined }
}

/**
 * The address writes are made from: the connected wallet's, or null while time travelling. Pass
 * it to the write gates (`isStakingDisabled`, `canManageValidator`, owner/manager checks...) so
 * every write action is disabled at a past round, while reads like "my stakes" keep using the
 * wallet's own address.
 */
export function useWriteAddress(): string | null {
  const { activeAddress } = useWallet()
  const { pinned } = useAtRound()
  return pinned ? null : activeAddress
}

/**
 * The time the page is showing, in seconds: the pinned round's block time, or undefined for the
 * wall clock. Calling it re-renders the component when that time lands, so the sunset helpers
 * (`isSunsetted`, `isStakingDisabled`...), which read it by default, are re-run.
 */
export function useViewedTime(): number | undefined {
  return React.useSyncExternalStore(subscribeViewedTime, getViewedTime)
}

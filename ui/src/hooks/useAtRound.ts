import { useRouterState, useSearch } from '@tanstack/react-router'
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

/** The round set for part of the page by {@link AtRoundProvider}; null outside one. */
const AtRoundContext = React.createContext<{ round?: bigint } | null>(null)

/**
 * The round the app is showing, from the root route's `?round=` search param, or from the
 * nearest {@link AtRoundProvider}. Every hook and route that builds protocol query options passes
 * `round` through, so the whole page reads as of the same round.
 */
export function useAtRound(): AtRound {
  const provided = React.useContext(AtRoundContext)
  // Only the round: a change to any other search param doesn't re-render every caller. Under a
  // provider the router's round isn't read (selected as null), so a round change reaches the
  // caller through the provider alone
  const routed = parseRound(
    useSearch({
      strict: false,
      select: (search) => (provided ? null : (search as { round?: unknown }).round),
    }),
  )
  const round = provided ? provided.round : routed
  return { round, pinned: round !== undefined }
}

/**
 * Sets the round {@link useAtRound} gives everything inside. The dashboard passes a deferred
 * round, so moving to another round re-renders it in the background (see `routes/index.tsx`).
 */
export function AtRoundProvider({
  round,
  children,
}: {
  round: bigint | undefined
  children: React.ReactNode
}) {
  const value = React.useMemo(() => ({ round }), [round])
  return React.createElement(AtRoundContext.Provider, { value }, children)
}

/**
 * The round the app is moving to: the URL's, from the moment a navigation starts. The routes,
 * and so {@link useAtRound}, only move once the new round's data has loaded; this is for what
 * should say at once where the app is going (the time travel banner and button).
 */
export function usePendingRound(): AtRound {
  const round = parseRound(
    useRouterState({
      select: (state) => (state.location.search as { round?: unknown }).round,
    }),
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
